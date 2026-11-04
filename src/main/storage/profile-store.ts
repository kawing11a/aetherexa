import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { catalogChangeSchema, connectionCatalogSchema, connectionProfileSchema, reusableFieldSchema, setupTemplateSchema, type ConnectionCatalog, type ConnectionProfile } from '@shared/profiles';
import { StorageError } from './storage-errors.js';
import type { ConnectionDirectoryStore } from './connection-directory-store.js';
import type { Result } from '@shared/contracts';

export class ProfileStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly directory: ConnectionDirectoryStore) {}

  private get filePath(): string { return join(this.directory.getDirectory(), 'profiles.json'); }

  async list(): Promise<ConnectionProfile[]> {
    const contents = await this.readContents();
    return contents.profiles;
  }

  async catalog(): Promise<ConnectionCatalog> {
    const contents = await this.readContents();
    return contents.catalog;
  }

  changeCatalog(input: unknown): Promise<ConnectionCatalog> {
    const change = catalogChangeSchema.parse(input);
    return this.serializeWrite(async () => {
      const contents = await this.readContents();
      const catalog = structuredClone(contents.catalog);
      if (change.type === 'create-group') {
        if (catalog.groups.some((name) => name.toLocaleLowerCase() === change.name.toLocaleLowerCase())) throw new StorageError('group-exists', 'A group with that name already exists.');
        catalog.groups.push(change.name);
      } else if (change.type === 'rename-group') {
        if (!catalog.groups.includes(change.from)) throw new StorageError('group-not-found', 'That group no longer exists.');
        if (catalog.groups.some((name) => name.toLocaleLowerCase() === change.to.toLocaleLowerCase())) throw new StorageError('group-exists', 'A group with that name already exists.');
        catalog.groups = catalog.groups.map((name) => name === change.from ? change.to : name);
        for (const profile of contents.profiles) if (profile.groupId === change.from) profile.groupId = change.to;
      } else if (change.type === 'remove-group') {
        if (!catalog.groups.includes(change.name)) throw new StorageError('group-not-found', 'That group no longer exists.');
        catalog.groups = catalog.groups.filter((name) => name !== change.name);
        for (const profile of contents.profiles) if (profile.groupId === change.name) profile.groupId = null;
      } else if (change.type === 'put-template') {
        const template = catalogTemplateSchema.parse(change.template);
        catalog.templates = [...catalog.templates.filter((item) => item.id !== template.id), template];
      } else if (change.type === 'remove-template') {
        catalog.templates = catalog.templates.filter((item) => item.id !== change.id);
      } else {
        const values = change.values.map((item) => reusableValueSchema.parse(item));
        catalog.reusableValues = [...values.slice().reverse(), ...catalog.reusableValues.filter((item) => !values.some((value) => item.target === value.target && item.field === value.field && stableJson(item.value) === stableJson(value.value)))].slice(0, 5000);
      }
      const validated = connectionCatalogSchema.parse(catalog);
      await this.writeContents({ version: 2, profiles: contents.profiles, catalog: validated });
      return validated;
    });
  }

  save(profileInput: unknown): Promise<void> {
    const profile = connectionProfileSchema.parse(profileInput);
    return this.serializeWrite(async () => {
      const contents = await this.readContents();
      const profiles = contents.profiles.filter((item) => item.id !== profile.id);
      profiles.push(profile);
      const groupNames = [...new Set([...contents.catalog.groups, ...profiles.map((item) => item.groupId).filter((item): item is string => Boolean(item))])];
      await this.writeContents({ version: 2, profiles, catalog: { ...contents.catalog, groups: groupNames } });
    });
  }

  remove(id: string): Promise<void> {
    return this.serializeWrite(async () => {
      const contents = await this.readContents();
      const profiles = contents.profiles.filter((item) => item.id !== id);
      await this.writeContents({ ...contents, profiles });
    });
  }

  migrateDirectory(directory: string, commitDirectory: () => Promise<void>): Promise<Result<{ profileCount: number }>> {
    const pending = this.writeChain.then(async () => {
      const prepared = await this.prepareDirectory(directory);
      if (!prepared.ok) return prepared;
      try { await commitDirectory(); return prepared; }
      catch { return failure('directory-setting-failed', 'The connection folder setting could not be saved. Your current folder is still active.'); }
    });
    this.writeChain = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async prepareDirectory(directory: string): Promise<Result<{ profileCount: number }>> {
    try {
      const source = await this.readContents();
      const targetPath = join(directory, 'profiles.json');
      const target = await this.readContents(targetPath);
      const byId = new Map(target.profiles.map((profile) => [profile.id, profile]));
      let migrated = 0;
      for (const profile of source.profiles) {
        const existing = byId.get(profile.id);
        if (existing && stableJson(existing) !== stableJson(profile)) {
          return failure('profile-conflict', 'The selected folder contains a different connection with the same ID. No profiles were changed.');
        }
        if (!existing) { byId.set(profile.id, profile); migrated += 1; }
      }
      const profiles = [...byId.values()];
      const catalog = mergeCatalogs(source.catalog, target.catalog, profiles);
      await this.writeContents({ version: 2, profiles, catalog }, targetPath);
      return { ok: true, value: { profileCount: migrated } };
    } catch {
      return failure('profile-migration-failed', 'Profiles could not be copied to the selected folder. Your current folder is still active.');
    }
  }

  private async readContents(filePath = this.filePath): Promise<StoreContents> {
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const envelope = zStoreSchema.safeParse(parsed);
      if (!envelope.success) throw new StorageError('corrupt-store', 'The local profile store is invalid.');

      const profiles: ConnectionProfile[] = [];
      for (const rawProfile of envelope.data.profiles) {
        const profile = connectionProfileSchema.safeParse(rawProfile);
        if (!profile.success) throw new StorageError('corrupt-store', 'The local profile store contains an invalid profile.');
        profiles.push(profile.data);
      }

      const catalog = envelope.data.version === 2 ? envelope.data.catalog : deriveLegacyCatalog(profiles);
      return { version: 2, profiles, catalog };
    } catch (error) {
      if (isMissingFile(error)) return { version: 2, profiles: [], catalog: emptyCatalog() };
      if (error instanceof StorageError) throw error;
      if (error instanceof SyntaxError) throw new StorageError('corrupt-store', 'The local profile store is unreadable.');
      throw error;
    }
  }

  private async writeContents(contents: StoreContents, filePath = this.filePath): Promise<void> {
    try {
      await writeAtomicJson(filePath, contents);
    } catch {
      throw new StorageError('write-failed', 'Profile changes could not be saved.');
    }
  }

  private serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.writeChain.then(operation);
    this.writeChain = pending.then(() => undefined, () => undefined);
    return pending;
  }
}

type StoreContents = { version: 2; profiles: ConnectionProfile[]; catalog: ConnectionCatalog };

function failure<T = never>(code: string, message: string): Result<T> { return { ok: false, error: { code, message, retryable: false } }; }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

const zStoreSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), profiles: z.array(z.unknown()) }).strict(),
  z.object({ version: z.literal(2), profiles: z.array(z.unknown()), catalog: connectionCatalogSchema }).strict(),
]);

const catalogTemplateSchema = setupTemplateSchema;
const reusableValueSchema = reusableFieldSchema;

function emptyCatalog(): ConnectionCatalog { return { groups: [], templates: [], reusableValues: [] }; }
function deriveLegacyCatalog(profiles: ConnectionProfile[]): ConnectionCatalog {
  return { ...emptyCatalog(), groups: [...new Set(profiles.map((profile) => profile.groupId).filter((group): group is string => Boolean(group)))] };
}
function mergeCatalogs(source: ConnectionCatalog, target: ConnectionCatalog, profiles: ConnectionProfile[]): ConnectionCatalog {
  const groups = [...new Set([...target.groups, ...source.groups, ...profiles.map((profile) => profile.groupId).filter((group): group is string => Boolean(group))])];
  const templates = [...target.templates];
  for (const template of source.templates) if (!templates.some((existing) => existing.id === template.id)) templates.push(template);
  const reusableValues = [...target.reusableValues];
  for (const value of source.reusableValues) if (!reusableValues.some((existing) => stableJson(existing) === stableJson(value))) reusableValues.push(value);
  return connectionCatalogSchema.parse({ groups, templates, reusableValues: reusableValues.slice(0, 5000) });
}

async function writeAtomicJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
