import { randomUUID } from 'node:crypto';
import { basename, posix } from 'node:path';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { dialog } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
import type { SFTPWrapper, Stats } from 'ssh2';
import type { Result } from '@shared/contracts';
import type { SftpEntry, TransferProgress } from '@shared/database';
import type { SshSessionManager } from '../ssh/ssh-session-manager.js';

type SftpSession = { ownerId: number; sshSessionId: string; sftp: SFTPWrapper };
export class SftpSessionManager {
  private readonly sessions = new Map<string, SftpSession>();
  constructor(private readonly ssh: SshSessionManager) {}
  async open(ownerId: number, sshSessionId: string): Promise<Result<{ sftpId: string }>> {
    const client = this.ssh.getClient(ownerId, sshSessionId);
    if (!client.ok) return client;
    return new Promise((resolve) => client.value.sftp((error, sftp) => {
      if (error) { resolve(failure('sftp-open-failed', 'The SFTP subsystem could not be opened.')); return; }
      const sftpId = randomUUID(); this.sessions.set(sftpId, { ownerId, sshSessionId, sftp });
      client.value.once('close', () => { sftp.end(); this.sessions.delete(sftpId); });
      resolve({ ok: true, value: { sftpId } });
    }));
  }
  async list(ownerId: number, id: string, inputPath: string): Promise<Result<SftpEntry[]>> {
    const found = this.owned(ownerId, id); if (!found.ok) return found;
    const path = validateRemotePath(inputPath); if (!path.ok) return path;
    return new Promise((resolve) => found.value.sftp.readdir(path.value, (error, items) => {
      if (error) { resolve(failure('sftp-list-failed', 'The remote directory could not be listed.')); return; }
      const entries = items.slice(0, 10_000).filter((item) => item.filename !== '.' && item.filename !== '..').map((item) => ({ name: item.filename, type: fileType(item.attrs), size: item.attrs.size, modifiedAt: item.attrs.mtime * 1000, permissions: item.attrs.mode }));
      resolve({ ok: true, value: entries });
    }));
  }
  async makeDirectory(ownerId: number, id: string, inputPath: string): Promise<Result<void>> { const found = this.owned(ownerId, id); if (!found.ok) return found; const path = validateRemotePath(inputPath); if (!path.ok) return path; return callbackResult((callback) => found.value.sftp.mkdir(path.value, callback), 'sftp-mkdir-failed'); }
  async rename(ownerId: number, id: string, from: string, to: string): Promise<Result<void>> {
    const found = this.owned(ownerId, id); if (!found.ok) return found;
    const source = validateRemotePath(from); const target = validateRemotePath(to); if (!source.ok) return source; if (!target.ok) return target;
    const existing = await this.exists(found.value.sftp, target.value); if (!existing.ok) return existing;
    if (existing.value) return failure('overwrite-confirmation-required', 'The destination already exists. Choose a new name before retrying.');
    return callbackResult((callback) => found.value.sftp.rename(source.value, target.value, callback), 'sftp-rename-failed');
  }
  async remove(ownerId: number, id: string, inputPath: string, directory: boolean): Promise<Result<void>> { const found = this.owned(ownerId, id); if (!found.ok) return found; const path = validateRemotePath(inputPath); if (!path.ok) return path; return callbackResult((callback) => directory ? found.value.sftp.rmdir(path.value, callback) : found.value.sftp.unlink(path.value, callback), 'sftp-remove-failed'); }

  async upload(ownerId: number, id: string, remotePath: string, window: BrowserWindow, webContents: WebContents): Promise<Result<TransferProgress>> {
    const found = this.owned(ownerId, id); if (!found.ok) return found;
    const target = validateRemotePath(remotePath); if (!target.ok) return target;
    const picked = await dialog.showOpenDialog(window, { properties: ['openFile'], title: 'Choose a file to upload' });
    if (picked.canceled || !picked.filePaths[0]) return failure('transfer-cancelled', 'The upload was cancelled.');
    const localPath = picked.filePaths[0];
    const remoteTarget = target.value.endsWith('/') ? posix.join(target.value, basename(localPath)) : target.value;
    const existing = await this.exists(found.value.sftp, remoteTarget); if (!existing.ok) return existing;
    if (existing.value) {
      const confirmation = await dialog.showMessageBox(window, { type: 'warning', title: 'Replace remote file?', message: 'A file with this name already exists.', detail: basename(remoteTarget), buttons: ['Replace', 'Cancel'], defaultId: 1, cancelId: 1 });
      if (confirmation.response !== 0) return failure('transfer-cancelled', 'The upload was cancelled.');
    }
    let total: number;
    try { total = (await stat(localPath)).size; } catch { return failure('transfer-read-failed', 'The selected file could not be read.'); }
    const transferId = randomUUID(); const fileName = basename(localPath);
    const progress = (transferredBytes: number) => { if (!webContents.isDestroyed()) webContents.send('sftp:transfer-progress', { transferId, direction: 'upload', fileName, transferredBytes, totalBytes: total, state: 'running' } satisfies TransferProgress); };
    try {
      let transferred = 0;
      const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) { transferred += chunk.length; progress(transferred); callback(null, chunk); } });
      const flags = existing.value ? 'w' : 'wx';
      await pipeline(createReadStream(localPath), meter, found.value.sftp.createWriteStream(remoteTarget, { flags }));
      const complete: TransferProgress = { transferId, direction: 'upload', fileName, transferredBytes: total, totalBytes: total, state: 'completed' };
      if (!webContents.isDestroyed()) webContents.send('sftp:transfer-progress', complete);
      return { ok: true, value: complete };
    } catch { return failure('transfer-failed', 'The file could not be uploaded.'); }
  }
  async download(ownerId: number, id: string, remotePath: string, window: BrowserWindow, webContents: WebContents): Promise<Result<TransferProgress>> {
    const found = this.owned(ownerId, id); if (!found.ok) return found;
    const source = validateRemotePath(remotePath); if (!source.ok) return source;
    const remote = await this.remoteStat(found.value.sftp, source.value); if (!remote.ok) return remote;
    const destination = await dialog.showSaveDialog(window, { defaultPath: basename(source.value), title: 'Save downloaded file' });
    if (destination.canceled || !destination.filePath) return failure('transfer-cancelled', 'The download was cancelled.');
    const transferId = randomUUID(); const fileName = basename(source.value); const total = remote.value.size;
    const progress = (transferredBytes: number) => { if (!webContents.isDestroyed()) webContents.send('sftp:transfer-progress', { transferId, direction: 'download', fileName, transferredBytes, totalBytes: total, state: 'running' } satisfies TransferProgress); };
    try {
      await new Promise<void>((resolve, reject) => found.value.sftp.fastGet(source.value, destination.filePath!, { step: (transferred) => progress(transferred) }, (error) => error ? reject(error) : resolve()));
      const complete: TransferProgress = { transferId, direction: 'download', fileName, transferredBytes: total, totalBytes: total, state: 'completed' };
      if (!webContents.isDestroyed()) webContents.send('sftp:transfer-progress', complete);
      return { ok: true, value: complete };
    } catch { return failure('transfer-failed', 'The file could not be downloaded.'); }
  }

  closeForSsh(ownerId: number, sshSessionId: string): void { for (const [id, session] of this.sessions) if (session.ownerId === ownerId && session.sshSessionId === sshSessionId) { session.sftp.end(); this.sessions.delete(id); } }
  closeProfile(profileId: string): void { for (const [id, session] of this.sessions) if (this.ssh.getProfileId(session.sshSessionId) === profileId) { session.sftp.end(); this.sessions.delete(id); } }
  closeOwner(ownerId: number): void { for (const [id, session] of this.sessions) if (session.ownerId === ownerId) { session.sftp.end(); this.sessions.delete(id); } }
  closeAll(): void { for (const session of this.sessions.values()) session.sftp.end(); this.sessions.clear(); }

  private owned(ownerId: number, id: string): Result<SftpSession> { const session = this.sessions.get(id); return session && session.ownerId === ownerId ? { ok: true, value: session } : failure('sftp-session-not-found', 'The SFTP session is closed or unavailable.'); }
  private exists(sftp: SFTPWrapper, path: string): Promise<Result<boolean>> { return new Promise((resolve) => sftp.stat(path, (error) => { if (!error) resolve({ ok: true, value: true }); else if ('code' in error && error.code === 2) resolve({ ok: true, value: false }); else resolve(failure('sftp-stat-failed', 'The remote destination could not be checked safely.')); })); }
  private remoteStat(sftp: SFTPWrapper, path: string): Promise<Result<Stats>> { return new Promise((resolve) => sftp.stat(path, (error, value) => error || !value ? resolve(failure('sftp-stat-failed', 'The remote file could not be read.')) : resolve({ ok: true, value }))); }
}
function validateRemotePath(input: string): Result<string> { if (!input || input.includes('\0') || input.split('/').some((part) => part === '..')) return failure('invalid-path', 'The remote path is invalid.'); return { ok: true, value: posix.normalize(input.startsWith('/') ? input : '/' + input) }; }
function fileType(attrs: Stats): SftpEntry['type'] { if (attrs.isDirectory()) return 'directory'; if (attrs.isFile()) return 'file'; if (attrs.isSymbolicLink()) return 'link'; return 'other'; }
function callbackResult(operation: (callback: (error?: Error | null) => void) => void, code: string): Promise<Result<void>> { return new Promise((resolve) => operation((error) => resolve(error ? failure(code, 'The remote file operation could not be completed.') : { ok: true, value: undefined }))); }
function failure<T = never>(code: string, message: string): Result<T> { return { ok: false, error: { code, message, retryable: false } }; }

