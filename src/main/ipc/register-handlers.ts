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
import type { UpdateManager } from '@main/update/update-manager.js';
import { registerUpdateHandlers } from './update-handlers.js';
import type { ConnectionDirectoryStore } from '@main/storage/connection-directory-store.js';
import { registerConnectionDirectoryHandlers } from './connection-directory-handlers.js';
import type { SshKeyManager } from '@main/ssh/ssh-key-manager.js';
import { registerSshKeyHandlers } from './ssh-key-handlers.js';
import type { FileSessionManager } from '@main/files/file-session-manager.js';
import { registerFileHandlers } from './file-handlers.js';

const emptyRequest = z.object({}).strict();
export type ApplicationServices = { profiles: ProfileStore; secrets: SecretStore; databases: DatabaseSessionManager; ssh: SshSessionManager; terminals: TerminalSessionManager; sftp: SftpSessionManager; knownHosts: KnownHostsStore; connectionDirectory: ConnectionDirectoryStore; sshKeys: SshKeyManager; files: FileSessionManager };

export function registerHandlers(window: BrowserWindow, services: ApplicationServices, updates: UpdateManager): void {
  ipcMain.removeHandler('app:get-version');
  ipcMain.handle('app:get-version', (event, input: unknown): Result<string> => {
    try { assertTrustedSender(event, window); emptyRequest.parse(input); return { ok: true, value: app.getVersion() }; }
    catch (error) {
      const safeError: AppError = error instanceof z.ZodError ? { code: 'invalid-input', message: 'This request was rejected.', retryable: false } : { code: 'untrusted-sender', message: 'This request was rejected.', retryable: false };
      return { ok: false, error: safeError };
    }
  });
  registerProfileHandlers(window, services.profiles, services.secrets, services.databases, services.ssh, services.sftp, services.terminals, services.knownHosts, services.sshKeys, services.files);
  registerDatabaseHandlers(window, services.databases);
  registerSshHandlers(window, services.profiles, services.ssh, services.terminals, services.sftp);
  registerUpdateHandlers(window, updates);
  registerConnectionDirectoryHandlers(window, services.connectionDirectory, services.profiles);
  registerSshKeyHandlers(window, services.sshKeys);
  registerFileHandlers(window, services.files);
}


