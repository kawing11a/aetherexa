import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { connectionProfileSchema, type ConnectionProfile } from '@shared/profiles';
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

  save(profileInput: unknown): Promise<void> {
    const profile = connectionProfileSchema.parse(profileInput);
    return this.serializeWrite(async () => {
      const contents = await this.readContents();
      const profiles = contents.profiles.filter((item) => item.id !== profile.id);
      profiles.push(profile);
      await this.writeContents({ version: 1, profiles });
    });
  }

  remove(id: string): Promise<void> {
    return this.serializeWrite(async () => {
      const contents = await this.readContents();
      const profiles = contents.profiles.filter((item) => item.id !== id);
      await this.writeContents({ version: 1, profiles });
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
      await this.writeContents({ version: 1, profiles: [...byId.values()] }, targetPath);
      return { ok: true, value: { profileCount: migrated } };
    } catch {
      return failure('profile-migration-failed', 'Profiles could not be copied to the selected folder. Your current folder is still active.');
    }
  }

  private async readContents(filePath = this.filePath): Promise<{ version: 1; profiles: ConnectionProfile[] }> {
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

      return { version: 1, profiles };
    } catch (error) {
      if (isMissingFile(error)) return { version: 1, profiles: [] };
      if (error instanceof StorageError) throw error;
      if (error instanceof SyntaxError) throw new StorageError('corrupt-store', 'The local profile store is unreadable.');
      throw error;
    }
  }

  private async writeContents(contents: { version: 1; profiles: ConnectionProfile[] }, filePath = this.filePath): Promise<void> {
    try {
      await writeAtomicJson(filePath, contents);
    } catch {
      throw new StorageError('write-failed', 'Profile changes could not be saved.');
    }
  }

  private serializeWrite(operation: () => Promise<void>): Promise<void> {
    const pending = this.writeChain.then(operation);
    this.writeChain = pending.catch(() => undefined);
    return pending;
  }
}

function failure<T = never>(code: string, message: string): Result<T> { return { ok: false, error: { code, message, retryable: false } }; }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

const zStoreSchema = z.object({
  version: z.literal(1),
  profiles: z.array(z.unknown()),
}).strict();

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
