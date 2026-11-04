import { randomUUID } from 'node:crypto';
import { basename, posix } from 'node:path';
import { stat, rm } from 'node:fs/promises';
import { dialog } from 'electron';
import { Client as FtpClient, FileType } from 'basic-ftp';
import type { TransferProgress } from '@shared/database';
import type { Result } from '@shared/contracts';
import type { RemoteEntry } from '@shared/files';
import type { FileProvider, FileProviderContext, FileProviderSession, RemoteFileProviderContext } from './provider-contracts.js';

export class FtpProvider implements FileProvider {
  async connect(context: FileProviderContext): Promise<Result<FileProviderSession>> {
    if (context.profile.protocol === 's3' || context.profile.protocol === 'sftp' || !('host' in context.profile)) return fail('wrong-provider', 'This connection does not use FTP.');
    const ftpContext: RemoteFileProviderContext = { ...context, profile: context.profile };
    const { profile, secrets } = ftpContext;
    if (!secrets.password) return fail('missing-password', 'Enter a password before connecting.');
    const client = new FtpClient(30_000, { maxListingBytes: 16 * 1024 * 1024 });
    client.ftp.verbose = false;
    try {
      await client.access({ host: profile.host, port: profile.port, user: profile.username, password: secrets.password, secure: profile.protocol === 'ftps-explicit' ? true : profile.protocol === 'ftps-implicit' ? 'implicit' : false, ...(profile.protocol !== 'ftp' ? { secureOptions: { rejectUnauthorized: true, servername: profile.host } } : {}) });
      return { ok: true, value: createSession(ftpContext, client) };
    } catch (error) {
      client.close();
      return fail('ftp-connect-failed', safeFtpError(error));
    }
  }
}

function createSession(context: RemoteFileProviderContext, client: FtpClient): FileProviderSession {
  const { profile, window, webContents } = context;
  return {
    profile,
    close: () => client.close(),
    async list(path) {
      const normalized = validPath(path); if (!normalized.ok) return normalized;
      try { const entries = await client.list(normalized.value); return { ok: true, value: entries.slice(0, 10_000).filter((item) => item.name !== '.' && item.name !== '..').map((item): RemoteEntry => ({ name: item.name, type: item.type === FileType.Directory ? 'directory' : item.type === FileType.File ? 'file' : item.type === FileType.SymbolicLink ? 'link' : 'other', size: item.isFile ? item.size : null, modifiedAt: item.modifiedAt?.getTime() ?? null })) }; }
      catch (error) { return fail('file-list-failed', safeFtpError(error)); }
    },
    async makeDirectory(path) { const normalized = validPath(path); if (!normalized.ok) return normalized; try { await client.ensureDir(normalized.value); return { ok: true, value: undefined }; } catch (error) { return fail('file-mkdir-failed', safeFtpError(error)); } },
    async remove(path, directory) { const normalized = validPath(path); if (!normalized.ok) return normalized; try { if (directory) await client.removeDir(normalized.value); else await client.remove(normalized.value); return { ok: true, value: undefined }; } catch (error) { return fail('file-remove-failed', safeFtpError(error)); } },
    async upload(path) {
      const target = validPath(path); if (!target.ok) return target;
      const picked = await dialog.showOpenDialog(window, { properties: ['openFile'], title: 'Choose a file to upload' });
      if (picked.canceled || !picked.filePaths[0]) return fail('transfer-cancelled', 'The upload was cancelled.');
      const localPath = picked.filePaths[0]; const remotePath = target.value.endsWith('/') ? posix.join(target.value, basename(localPath)) : target.value;
      const parent = posix.dirname(remotePath); const name = posix.basename(remotePath);
      try {
        const collision = (await client.list(parent)).some((item) => item.name === name);
        if (collision && (await dialog.showMessageBox(window, { type: 'warning', title: 'Replace remote file?', message: 'A file with this name already exists.', detail: name, buttons: ['Replace', 'Cancel'], defaultId: 1, cancelId: 1 })).response !== 0) return fail('transfer-cancelled', 'The upload was cancelled.');
        const total = (await stat(localPath)).size; const transferId = randomUUID(); const fileName = basename(localPath); let transferred = 0;
        const send = (bytes: number, state: TransferProgress['state']) => { if (!webContents.isDestroyed()) webContents.send('files:transfer-progress', { transferId, direction: 'upload', fileName, transferredBytes: bytes, totalBytes: total, state } satisfies TransferProgress); };
        client.trackProgress((event) => { transferred = event.bytes; send(transferred, 'running'); });
        await client.uploadFrom(localPath, remotePath); client.trackProgress(); send(total, 'completed');
        return { ok: true, value: { transferId, direction: 'upload', fileName, transferredBytes: total, totalBytes: total, state: 'completed' } };
      } catch (error) { client.trackProgress(); return fail('transfer-failed', safeFtpError(error)); }
    },
    async download(path) {
      const source = validPath(path); if (!source.ok) return source;
      const destination = await dialog.showSaveDialog(window, { defaultPath: basename(source.value), title: 'Save downloaded file' });
      if (destination.canceled || !destination.filePath) return fail('transfer-cancelled', 'The download was cancelled.');
      const transferId = randomUUID(); const fileName = basename(source.value); let total: number | null = null; let transferred = 0;
      try { total = await client.size(source.value); } catch { /* Some FTP servers do not expose SIZE. */ }
      try {
        const send = (bytes: number, state: TransferProgress['state']) => { if (!webContents.isDestroyed()) webContents.send('files:transfer-progress', { transferId, direction: 'download', fileName, transferredBytes: bytes, totalBytes: total, state } satisfies TransferProgress); };
        client.trackProgress((event) => { transferred = event.bytes; send(transferred, 'running'); });
        await client.downloadTo(destination.filePath, source.value); client.trackProgress(); send(total ?? transferred, 'completed');
        return { ok: true, value: { transferId, direction: 'download', fileName, transferredBytes: total ?? transferred, totalBytes: total, state: 'completed' } };
      } catch (error) { client.trackProgress(); await rm(destination.filePath, { force: true }).catch(() => undefined); return fail('transfer-failed', safeFtpError(error)); }
    },
  };
}

function validPath(input: string): Result<string> { if (!input || input.includes('\0') || input.split('/').some((part) => part === '..')) return fail('invalid-path', 'The remote path is invalid.'); return { ok: true, value: posix.normalize(input.startsWith('/') ? input : '/' + input) }; }
function fail<T = never>(code: string, message: string, retryable = false): Result<T> { return { ok: false, error: { code, message, retryable } }; }
function safeFtpError(error: unknown): string { if (error instanceof Error && /certificate|self.signed/i.test(error.message)) return 'The FTPS certificate could not be verified.'; if (error instanceof Error && /530|auth|login/i.test(error.message)) return 'The FTP server rejected the configured credentials.'; if (error instanceof Error && /timeout/i.test(error.message)) return 'The FTP server did not respond before the connection timed out.'; return 'The FTP operation could not be completed. Check the server settings and try again.'; }
