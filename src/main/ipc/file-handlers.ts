import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { z } from 'zod';
import type { AppError, Result } from '@shared/contracts';
import { fileConnectSchema, fileSessionSchema, filePathSchema, fileTransferSchema, fileRemoveSchema, fileHostKeyReviewSchema } from '@shared/database-validation';
import type { FileSessionManager } from '@main/files/file-session-manager.js';
import { assertTrustedSender } from './trusted-sender.js';

export function registerFileHandlers(window: BrowserWindow, files: FileSessionManager): void {
  register('files:connect', fileConnectSchema, (owner, input) => files.connect(owner, input.profileId, window, window.webContents));
  register('files:disconnect', fileSessionSchema, (owner, input) => files.disconnect(owner, input.sessionId));
  register('files:list', filePathSchema, (owner, input) => files.list(owner, input.sessionId, input.path));
  register('files:mkdir', filePathSchema, (owner, input) => files.makeDirectory(owner, input.sessionId, input.path));
  register('files:remove', fileRemoveSchema, (owner, input) => files.remove(owner, input.sessionId, input.path, input.directory));
  register('files:upload', fileTransferSchema, (owner, input) => files.upload(owner, input.sessionId, input.path));
  register('files:download', fileTransferSchema, (owner, input) => files.download(owner, input.sessionId, input.path));
  register('files:review-host-key', fileHostKeyReviewSchema, (owner, input) => files.reviewHostKey(owner, input.requestId, input.accept, input.replaceChangedKey));
  window.webContents.once('destroyed', () => files.closeOwner(window.webContents.id));

  function register<T>(channel: string, schema: z.ZodType<T>, operation: (owner: number, input: T) => unknown): void {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, raw: unknown) => {
      try { assertTrustedSender(event, window); return await operation(event.sender.id, schema.parse(raw)); }
      catch (error) {
        const safe: AppError = error instanceof z.ZodError ? { code: 'invalid-input', message: 'Check the file operation details and try again.', retryable: false } : { code: 'file-operation-failed', message: 'The file operation could not be completed.', retryable: false };
        return { ok: false, error: safe } satisfies Result<never>;
      }
    });
  }
}
