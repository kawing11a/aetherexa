import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { connectionProfileSchema, type ConnectionProfile } from '@shared/profiles';
import { StorageError } from './storage-errors.js';

export class ProfileStore {
  private readonly filePath = join(app.getPath('userData'), 'profiles.json');
  private writeChain: Promise<void> = Promise.resolve();

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

  private async readContents(): Promise<{ version: 1; profiles: ConnectionProfile[] }> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
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

  private async writeContents(contents: { version: 1; profiles: ConnectionProfile[] }): Promise<void> {
    try {
      await writeAtomicJson(this.filePath, contents);
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
