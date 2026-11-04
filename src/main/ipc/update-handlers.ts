import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import type { AppError, Result } from '@shared/contracts';
import { z } from 'zod';
import { UpdateManager } from '@main/update/update-manager.js';
import { assertTrustedSender } from './trusted-sender.js';

const emptyRequest = z.object({}).strict();

export function registerUpdateHandlers(window: BrowserWindow, updates: UpdateManager): void {
  updates.attachWindow(window);

  ipcMain.removeHandler('app:update-status');
  ipcMain.handle('app:update-status', (event, input: unknown): Result<ReturnType<UpdateManager['getStatus']>> => {
    try {
      assertTrustedSender(event, window);
      emptyRequest.parse(input);
      return { ok: true, value: updates.getStatus() };
    } catch {
      return { ok: false, error: invalidRequestError() };
    }
  });

  ipcMain.removeHandler('app:check-for-updates');
  ipcMain.handle('app:check-for-updates', (event, input: unknown): Result<ReturnType<UpdateManager['getStatus']>> => {
    try {
      assertTrustedSender(event, window);
      emptyRequest.parse(input);
      return { ok: true, value: updates.checkNow() };
    } catch {
      return { ok: false, error: invalidRequestError() };
    }
  });

  ipcMain.removeHandler('app:install-update');
  ipcMain.handle('app:install-update', (event, input: unknown): Result<void> => {
    try {
      assertTrustedSender(event, window);
      emptyRequest.parse(input);
      updates.install();
      return { ok: true, value: undefined };
    } catch {
      return { ok: false, error: invalidRequestError() };
    }
  });
}

function invalidRequestError(): AppError {
  return { code: 'invalid-input', message: 'This update request was rejected.', retryable: false };
}
