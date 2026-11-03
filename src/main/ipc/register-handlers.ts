import { app, ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import type { ProfileStore } from '@main/storage/profile-store';
import type { SecretStore } from '@main/storage/secret-store';
import type { DatabaseSessionManager } from '@main/connectors/database-session-manager';
import type { AppError, Result } from '@shared/contracts';
import { z } from 'zod';
import { assertTrustedSender } from './trusted-sender.js';
import { registerProfileHandlers } from './profile-handlers.js';
import { registerDatabaseHandlers } from './database-handlers.js';
import { registerSshHandlers } from './ssh-handlers.js';
import type { SshSessionManager } from '@main/ssh/ssh-session-manager';
import type { TerminalSessionManager } from '@main/terminal/terminal-session-manager';
import type { SftpSessionManager } from '@main/sftp/sftp-session-manager';
import type { KnownHostsStore } from '@main/ssh/known-hosts-store';

const emptyRequest = z.object({}).strict();
export type ApplicationServices = { profiles: ProfileStore; secrets: SecretStore; databases: DatabaseSessionManager; ssh: SshSessionManager; terminals: TerminalSessionManager; sftp: SftpSessionManager; knownHosts: KnownHostsStore };

export function registerHandlers(window: BrowserWindow, services: ApplicationServices): void {
  ipcMain.removeHandler('app:get-version');
  ipcMain.handle('app:get-version', (event, input: unknown): Result<string> => {
    try { assertTrustedSender(event, window); emptyRequest.parse(input); return { ok: true, value: app.getVersion() }; }
    catch (error) {
      const safeError: AppError = error instanceof z.ZodError ? { code: 'invalid-input', message: 'This request was rejected.', retryable: false } : { code: 'untrusted-sender', message: 'This request was rejected.', retryable: false };
      return { ok: false, error: safeError };
    }
  });
  registerProfileHandlers(window, services.profiles, services.secrets, services.databases, services.ssh, services.sftp, services.terminals, services.knownHosts);
  registerDatabaseHandlers(window, services.databases);
  registerSshHandlers(window, services.profiles, services.ssh, services.terminals, services.sftp);
}


