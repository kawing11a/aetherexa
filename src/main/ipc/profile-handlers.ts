import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { profileIdInputSchema, profileSaveInputSchema } from '@shared/validation';
import { parseConnectionProfile, secretBundleSchema } from '@shared/profiles';
import type { AppError, Result } from '@shared/contracts';
import { ProfileStore } from '@main/storage/profile-store';
import { SecretStore } from '@main/storage/secret-store';
import { StorageError } from '@main/storage/storage-errors';
import { assertTrustedSender } from './trusted-sender.js';
import type { DatabaseSessionManager } from '@main/connectors/database-session-manager';
import type { SshSessionManager } from '@main/ssh/ssh-session-manager';
import type { SftpSessionManager } from '@main/sftp/sftp-session-manager';
import type { TerminalSessionManager } from '@main/terminal/terminal-session-manager';
import type { KnownHostsStore } from '@main/ssh/known-hosts-store';

const emptyRequest = z.object({}).strict();

export function registerProfileHandlers(window: BrowserWindow, profileStore: ProfileStore, secretStore: SecretStore, databases: DatabaseSessionManager, ssh: SshSessionManager, sftp: SftpSessionManager, terminals: TerminalSessionManager, knownHosts: KnownHostsStore): void {

  for (const channel of ['profiles:list', 'profiles:save', 'profiles:remove']) {
    ipcMain.removeHandler(channel);
  }

  ipcMain.handle('profiles:list', (event, input: unknown) => runResult(async () => {
    assertTrustedSender(event, window);
    emptyRequest.parse(input);
    return profileStore.list();
  }));

  ipcMain.handle('profiles:save', (event, input: unknown) => runResult(async () => {
    assertTrustedSender(event, window);
    const parsed = profileSaveInputSchema.parse(input);
    const profile = parseConnectionProfile(parsed.profile);
    const secrets = parsed.secrets === undefined ? undefined : secretBundleSchema.parse(parsed.secrets);
    if (secrets !== undefined) {
      const revision = randomUUID();
      await secretStore.set(profile.id, secrets, revision);
      try { await profileStore.save({ ...profile, secretRevision: revision }); }
      catch (error) { await secretStore.removeRevision(profile.id, revision).catch(() => undefined); throw error; }
      await secretStore.removeRevision(profile.id, profile.secretRevision).catch(() => undefined);
      if (!profile.secretRevision) await secretStore.removeRevision(profile.id).catch(() => undefined);
    } else {
      await profileStore.save(profile);
    }
    return undefined;
  }));

  ipcMain.handle('profiles:remove', (event, input: unknown) => runResult(async () => {
    assertTrustedSender(event, window);
    const { id } = profileIdInputSchema.parse(input);
    await databases.closeProfile(id);
    sftp.closeProfile(id);
    terminals.closeProfile(id);
    await ssh.closeProfile(id);
    await knownHosts.remove(id);
    await profileStore.remove(id);
    await secretStore.remove(id);
    return undefined;
  }));
}

async function runResult<T>(operation: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error: toAppError(error) };
  }
}

function toAppError(error: unknown): AppError {
  if (error instanceof z.ZodError) {
    return { code: 'invalid-input', message: 'Check the connection details and try again.', retryable: false };
  }
  if (error instanceof StorageError) {
    return { code: error.code, message: error.message, retryable: error.code === 'write-failed' };
  }
  if (error instanceof Error && error.message === 'Untrusted IPC sender') {
    return { code: 'untrusted-sender', message: 'This request was rejected.', retryable: false };
  }
  return { code: 'profile-operation-failed', message: 'The profile change could not be completed.', retryable: true };
}






