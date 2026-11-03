import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { z } from 'zod';
import type { AppError, Result } from '@shared/contracts';
import { sshConnectSchema, hostKeyReviewSchema, terminalOpenSchema, localTerminalOpenSchema, terminalIdSchema, terminalWriteSchema, terminalResizeSchema, sftpOpenSchema, sftpListSchema, sftpRenameSchema, sftpRemoveSchema, sftpPathSchema, sftpTransferSchema } from '@shared/database-validation';
import type { ProfileStore } from '@main/storage/profile-store';
import type { SshSessionManager } from '@main/ssh/ssh-session-manager';
import type { TerminalSessionManager } from '@main/terminal/terminal-session-manager';
import type { SftpSessionManager } from '@main/sftp/sftp-session-manager';
import { assertTrustedSender } from './trusted-sender.js';

export function registerSshHandlers(window: BrowserWindow, profiles: ProfileStore, ssh: SshSessionManager, terminals: TerminalSessionManager, sftp: SftpSessionManager): void {
  const register = <T>(channel: string, schema: z.ZodType<T>, operation: (owner: number, input: T) => unknown) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, raw: unknown) => {
      try { assertTrustedSender(event, window); return await operation(event.sender.id, schema.parse(raw)); }
      catch (error) {
        const safe: AppError = error instanceof z.ZodError ? { code: 'invalid-input', message: 'Check the request details and try again.', retryable: false } : error instanceof Error && error.message === 'Untrusted IPC sender' ? { code: 'untrusted-sender', message: 'This request was rejected.', retryable: false } : { code: 'ssh-operation-failed', message: 'The SSH or SFTP operation could not be completed.', retryable: false };
        return { ok: false, error: safe } satisfies Result<never>;
      }
    });
  };
  register('ssh:connect', sshConnectSchema, (owner, input) => ssh.connect(owner, input.profileId, window.webContents));
  register('ssh:disconnect', z.object({ sessionId: z.string().uuid() }).strict(), async (owner, input) => { terminals.closeForSsh(owner, input.sessionId); sftp.closeForSsh(owner, input.sessionId); return ssh.disconnect(owner, input.sessionId); });
  register('ssh:review-host-key', hostKeyReviewSchema, (owner, input) => ssh.reviewHostKey(owner, input.requestId, input.accept, input.replaceChangedKey));
  register('ssh:open-terminal', terminalOpenSchema, (owner, input) => terminals.openSsh(owner, input.sessionId, input.cols, input.rows, window.webContents));
  register('ssh:attach-terminal', terminalIdSchema, (owner, input) => terminals.attachRenderer(owner, input.terminalId));
  register('ssh:open-local-terminal', localTerminalOpenSchema, (owner, input) => terminals.openLocal(owner, input.cols, input.rows, window.webContents));
  register('ssh:write-terminal', terminalWriteSchema, (owner, input) => terminals.write(owner, input.terminalId, input.data));
  register('ssh:resize-terminal', terminalResizeSchema, (owner, input) => terminals.resize(owner, input.terminalId, input.cols, input.rows));
  register('ssh:close-terminal', terminalIdSchema, (owner, input) => terminals.close(owner, input.terminalId));
  register('sftp:open', sftpOpenSchema, (owner, input) => sftp.open(owner, input.sessionId));
  register('sftp:list', sftpListSchema, (owner, input) => sftp.list(owner, input.sftpId, input.path));
  register('sftp:mkdir', sftpPathSchema, (owner, input) => sftp.makeDirectory(owner, input.sftpId, input.path));
  register('sftp:rename', sftpRenameSchema, (owner, input) => sftp.rename(owner, input.sftpId, input.from, input.to));
  register('sftp:remove', sftpRemoveSchema, (owner, input) => sftp.remove(owner, input.sftpId, input.path, input.directory));
  register('sftp:upload', sftpTransferSchema, (owner, input) => sftp.upload(owner, input.sftpId, input.remotePath, window, window.webContents));
  register('sftp:download', sftpTransferSchema, (owner, input) => sftp.download(owner, input.sftpId, input.remotePath, window, window.webContents));
  window.webContents.once('destroyed', () => { const owner = window.webContents.id; terminals.closeOwner(owner); sftp.closeOwner(owner); void ssh.closeOwner(owner); });
}



