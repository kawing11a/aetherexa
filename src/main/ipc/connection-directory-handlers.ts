import { dialog, ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { z } from 'zod';
import type { ConnectionDirectoryStore } from '@main/storage/connection-directory-store.js';
import type { ProfileStore } from '@main/storage/profile-store.js';
import type { AppError, Result } from '@shared/contracts';
import { assertTrustedSender } from './trusted-sender.js';

const empty = z.object({}).strict();
const setDirectory = z.object({ directory: z.string().trim().min(1).max(4096) }).strict();

export function registerConnectionDirectoryHandlers(window: BrowserWindow, directory: ConnectionDirectoryStore, profiles: ProfileStore): void {
  register('connection-directory:get', empty, () => ({ directory: directory.getDirectory() }));
  register('connection-directory:choose', empty, async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Choose connection folder', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  register('connection-directory:set', setDirectory, (input) => directory.setDirectory(input.directory, profiles));

  function register<T, V>(channel: string, schema: z.ZodType<T>, operation: (input: T) => V | Promise<V>): void {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, raw: unknown) => {
      try {
        assertTrustedSender(event, window);
        const value = await operation(schema.parse(raw));
        return isResult(value) ? value : { ok: true, value } satisfies Result<Awaited<V>>;
      } catch (error) {
        const safeError: AppError = error instanceof z.ZodError
          ? { code: 'invalid-input', message: 'Choose a valid connection folder.', retryable: false }
          : { code: 'connection-directory-failed', message: 'The connection folder request could not be completed.', retryable: false };
        return { ok: false, error: safeError } satisfies Result<never>;
      }
    });
  }
}

function isResult(value: unknown): value is Result<unknown> {
  return typeof value === 'object' && value !== null && 'ok' in value && typeof value.ok === 'boolean';
}
