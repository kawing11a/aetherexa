import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Result } from '@shared/contracts';
import type { ProfileStore } from './profile-store.js';

const settingsSchema = z.object({ version: z.literal(1), directory: z.string().min(1).max(4096) }).strict();

export class ConnectionDirectoryStore {
  private readonly filePath = join(app.getPath('userData'), 'connection-directory.json');
  private directory = app.getPath('userData');

  async initialize(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      const settings = settingsSchema.parse(parsed);
      const chosen = resolve(settings.directory);
      const info = await stat(chosen);
      if (info.isDirectory()) this.directory = chosen;
    } catch (error) {
      if (!isMissingFile(error) && !(error instanceof z.ZodError) && !(error instanceof SyntaxError)) throw error;
    }
  }

  getDirectory(): string { return this.directory; }

  async setDirectory(inputPath: string, profiles: ProfileStore): Promise<Result<{ directory: string; profileCount: number }>> {
    if (!inputPath || !isAbsolute(inputPath)) return failure('invalid-directory', 'Choose a valid local folder.');
    const next = resolve(inputPath);
    if (next === this.directory) return { ok: true, value: { directory: next, profileCount: 0 } };
    try {
      const info = await stat(next).catch((error: unknown) => isMissingFile(error) ? undefined : Promise.reject(error));
      if (info && !info.isDirectory()) return failure('invalid-directory', 'The selected path is not a folder.');
      await mkdir(next, { recursive: true });
      return await profiles.migrateDirectory(next, async () => {
        await writeAtomicJson(this.filePath, { version: 1, directory: next });
        this.directory = next;
      }).then((prepared) => prepared.ok ? { ok: true, value: { directory: next, profileCount: prepared.value.profileCount } } : prepared);
    } catch {
      return failure('directory-change-failed', 'The connection folder could not be changed. Your current folder is still active.');
    }
  }
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

function isMissingFile(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'; }
function failure<T = never>(code: string, message: string): Result<T> { return { ok: false, error: { code, message, retryable: false } }; }
