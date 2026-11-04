import { createHash, randomUUID } from 'node:crypto';
import { basename, posix } from 'node:path';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { dialog } from 'electron';
import { Client } from 'ssh2';
import type { Client as SshClient, ConnectConfig, SFTPWrapper, Stats } from 'ssh2';
import type { HostKeyNotice, TransferProgress } from '@shared/database';
import type { FileProvider, FileProviderContext, FileProviderSession, RemoteFileProviderContext } from './provider-contracts.js';
import type { SshKeyManager } from '@main/ssh/ssh-key-manager.js';
import type { KnownHostsStore } from '@main/ssh/known-hosts-store.js';
import type { RemoteEntry } from '@shared/files';
import type { Result } from '@shared/contracts';

type PendingReview = { ownerId: number; profileId: string; host: string; port: number; fingerprint: string; changed: boolean; verify(valid: boolean): void; timer: NodeJS.Timeout };

export class SftpProvider implements FileProvider {
  private readonly pending = new Map<string, PendingReview>();
  constructor(private readonly keys: SshKeyManager, private readonly knownHosts: KnownHostsStore) {}

  async connect(context: FileProviderContext): Promise<Result<FileProviderSession>> {
    if (context.profile.protocol !== 'sftp' || !('host' in context.profile)) return fail('wrong-provider', 'This connection does not use SFTP.');
    const sftpContext: RemoteFileProviderContext = { ...context, profile: context.profile };
    const { profile, ownerId, webContents, window } = sftpContext;
    const client = new Client();
    try {
      const config = await this.config(sftpContext);
      config.hostVerifier = (key: Buffer, verify: (valid: boolean) => void) => { void this.verifyHost(sftpContext, client, key, verify); };
      const connected = await new Promise<Result<void>>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => { if (!settled) { settled = true; client.end(); resolve(fail('timeout', 'The SFTP server did not respond before the connection timed out.', true)); } }, 100_000);
        client.once('ready', () => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ok: true, value: undefined }); });
        client.on('error', (error) => { if (settled) return; settled = true; clearTimeout(timer); client.end(); resolve(fail('sftp-connect-failed', safeSshError(error))); });
        try { client.connect(config); } catch { settled = true; clearTimeout(timer); client.end(); resolve(fail('sftp-connect-failed', 'The SFTP connection could not be completed.')); }
      });
      if (!connected.ok) return connected;
      const opened = await new Promise<SFTPWrapper | undefined>((resolve) => client.sftp((error, sftp) => resolve(error ? undefined : sftp)));
      if (!opened) { client.end(); return fail('sftp-open-failed', 'The SFTP subsystem could not be opened.'); }
      return { ok: true, value: makeSession(sftpContext, client, opened) };
    } catch {
      client.end();
      return fail('sftp-connect-failed', 'The SFTP connection could not be completed.');
    }
  }

  async reviewHostKey(ownerId: number, requestId: string, accept: boolean, replaceChangedKey = false): Promise<Result<void>> {
    const pending = this.pending.get(requestId);
    if (!pending || pending.ownerId !== ownerId) return fail('host-key-review-expired', 'The SSH host key review is no longer active.');
    clearTimeout(pending.timer); this.pending.delete(requestId);
    if (!accept) { pending.verify(false); return { ok: true, value: undefined }; }
    if (pending.changed && !replaceChangedKey) { pending.verify(false); return fail('host-key-replacement-required', 'Review the changed host key before accepting it.'); }
    try { await this.knownHosts.set(pending.profileId, pending.host, pending.port, pending.fingerprint); pending.verify(true); return { ok: true, value: undefined }; }
    catch { pending.verify(false); return fail('host-key-save-failed', 'The SSH host key could not be saved.'); }
  }

  closeOwner(ownerId: number): void { for (const [id, pending] of this.pending) if (pending.ownerId === ownerId) { clearTimeout(pending.timer); pending.verify(false); this.pending.delete(id); } }
  closeProfile(profileId: string): void { for (const [id, pending] of this.pending) if (pending.profileId === profileId) { clearTimeout(pending.timer); pending.verify(false); this.pending.delete(id); } }
  closeAll(): void { for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.verify(false); this.pending.delete(id); } }

  private async config(context: RemoteFileProviderContext): Promise<ConnectConfig> {
    const { profile, secrets } = context;
    const config: ConnectConfig = { host: profile.host, port: profile.port, username: profile.username, readyTimeout: 90_000, keepaliveInterval: 15_000, keepaliveCountMax: 3 };
    if (profile.authentication === 'password') {
      if (!secrets.password) throw new Error('Missing password');
      return { ...config, password: secrets.password };
    }
    if (profile.authentication === 'key-manager') {
      if (!profile.keyFingerprint) throw new Error('Missing key');
      const key = await this.keys.getPrivateKey(profile.keyFingerprint);
      return { ...config, privateKey: key.privateKey, ...(key.passphrase ? { passphrase: key.passphrase } : {}) };
    }
    const agent = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? 'pageant' : undefined);
    if (!agent) throw new Error('Missing SSH agent');
    return { ...config, agent };
  }

  private async verifyHost(context: RemoteFileProviderContext, client: SshClient, key: Buffer, verify: (valid: boolean) => void): Promise<void> {
    const { profile, ownerId, webContents } = context;
    const fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
    try {
      const previousFingerprint = await this.knownHosts.get(profile.id, profile.host, profile.port) ?? null;
      if (previousFingerprint === fingerprint) { verify(true); return; }
      const requestId = randomUUID(); const changed = previousFingerprint !== null;
      const timer = setTimeout(() => { this.pending.delete(requestId); verify(false); }, 60_000);
      this.pending.set(requestId, { ownerId, profileId: profile.id, host: profile.host, port: profile.port, fingerprint, changed, verify, timer });
      const notice: HostKeyNotice = { requestId, profileId: profile.id, host: profile.host, port: profile.port, currentFingerprint: fingerprint, previousFingerprint, changed };
      if (webContents.isDestroyed()) { clearTimeout(timer); this.pending.delete(requestId); verify(false); return; }
      webContents.send('files:host-key', notice);
    } catch { verify(false); }
  }
}

function makeSession(context: RemoteFileProviderContext, client: SshClient, sftp: SFTPWrapper): FileProviderSession {
  const { profile, window, webContents } = context;
  return {
    profile,
    close: () => { sftp.end(); client.end(); },
    async list(inputPath) {
      const path = validPath(inputPath); if (!path.ok) return path;
      return new Promise((resolve) => sftp.readdir(path.value, (error, items) => {
        if (error) { resolve(fail('file-list-failed', 'The remote directory could not be listed.')); return; }
        resolve({ ok: true, value: items.slice(0, 10_000).filter((item) => item.filename !== '.' && item.filename !== '..').map((item): RemoteEntry => ({ name: item.filename, type: entryType(item.attrs), size: item.attrs.size, modifiedAt: item.attrs.mtime * 1000 })) });
      }));
    },
    async makeDirectory(inputPath) { const path = validPath(inputPath); if (!path.ok) return path; return callback((done) => sftp.mkdir(path.value, done), 'file-mkdir-failed'); },
    async remove(inputPath, directory) { const path = validPath(inputPath); if (!path.ok) return path; return callback((done) => directory ? sftp.rmdir(path.value, done) : sftp.unlink(path.value, done), 'file-remove-failed'); },
    async upload(inputPath) {
      const target = validPath(inputPath); if (!target.ok) return target;
      const picked = await dialog.showOpenDialog(window, { properties: ['openFile'], title: 'Choose a file to upload' });
      if (picked.canceled || !picked.filePaths[0]) return fail('transfer-cancelled', 'The upload was cancelled.');
      const localPath = picked.filePaths[0]; const remotePath = target.value.endsWith('/') ? posix.join(target.value, basename(localPath)) : target.value;
      const exists = await sftpExists(sftp, remotePath); if (!exists.ok) return exists;
      if (exists.value && (await dialog.showMessageBox(window, { type: 'warning', title: 'Replace remote file?', message: 'A file with this name already exists.', detail: basename(remotePath), buttons: ['Replace', 'Cancel'], defaultId: 1, cancelId: 1 })).response !== 0) return fail('transfer-cancelled', 'The upload was cancelled.');
      let total: number; try { total = (await stat(localPath)).size; } catch { return fail('transfer-read-failed', 'The selected file could not be read.'); }
      const transferId = randomUUID(); const fileName = basename(localPath); let transferred = 0;
      const send = (bytes: number, state: TransferProgress['state']) => { if (!webContents.isDestroyed()) webContents.send('files:transfer-progress', { transferId, direction: 'upload', fileName, transferredBytes: bytes, totalBytes: total, state } satisfies TransferProgress); };
      try { const meter = new Transform({ transform(chunk: Buffer, _encoding, done) { transferred += chunk.length; send(transferred, 'running'); done(null, chunk); } }); await pipeline(createReadStream(localPath), meter, sftp.createWriteStream(remotePath, { flags: exists.value ? 'w' : 'wx' })); send(total, 'completed'); return { ok: true, value: { transferId, direction: 'upload', fileName, transferredBytes: total, totalBytes: total, state: 'completed' } }; }
      catch { send(transferred, 'failed'); return fail('transfer-failed', 'The file could not be uploaded.'); }
    },
    async download(inputPath) {
      const source = validPath(inputPath); if (!source.ok) return source;
      const destination = await dialog.showSaveDialog(window, { defaultPath: basename(source.value), title: 'Save downloaded file' });
      if (destination.canceled || !destination.filePath) return fail('transfer-cancelled', 'The download was cancelled.');
      const transferId = randomUUID(); const fileName = basename(source.value);
      try {
        const attrs = await new Promise<{ size: number }>((resolve, reject) => sftp.stat(source.value, (error, value) => error || !value ? reject(error) : resolve(value)));
        const total = attrs.size; let transferred = 0;
        await new Promise<void>((resolve, reject) => sftp.fastGet(source.value, destination.filePath!, { step: (bytes) => { transferred = bytes; if (!webContents.isDestroyed()) webContents.send('files:transfer-progress', { transferId, direction: 'download', fileName, transferredBytes: bytes, totalBytes: total, state: 'running' } satisfies TransferProgress); } }, (error) => error ? reject(error) : resolve()));
        const value: TransferProgress = { transferId, direction: 'download', fileName, transferredBytes: total, totalBytes: total, state: 'completed' }; if (!webContents.isDestroyed()) webContents.send('files:transfer-progress', value); return { ok: true, value };
      } catch { return fail('transfer-failed', 'The file could not be downloaded.'); }
    },
  };
}

function validPath(input: string): Result<string> { if (!input || input.includes('\0') || input.split('/').some((part) => part === '..')) return fail('invalid-path', 'The remote path is invalid.'); return { ok: true, value: posix.normalize(input.startsWith('/') ? input : '/' + input) }; }
function entryType(attrs: Stats): RemoteEntry['type'] { if (attrs.isDirectory()) return 'directory'; if (attrs.isFile()) return 'file'; if (attrs.isSymbolicLink()) return 'link'; return 'other'; }
function callback(operation: (done: (error?: Error | null) => void) => void, code: string): Promise<Result<void>> { return new Promise((resolve) => operation((error) => resolve(error ? fail(code, 'The remote file operation could not be completed.') : { ok: true, value: undefined }))); }
function sftpExists(sftp: SFTPWrapper, path: string): Promise<Result<boolean>> { return new Promise((resolve) => sftp.stat(path, (error) => { if (!error) resolve({ ok: true, value: true }); else if ('code' in error && error.code === 2) resolve({ ok: true, value: false }); else resolve(fail('file-stat-failed', 'The remote destination could not be checked safely.')); })); }
function fail<T = never>(code: string, message: string, retryable = false): Result<T> { return { ok: false, error: { code, message, retryable } }; }
function safeSshError(error: Error): string { if (/authentication/i.test(error.message)) return 'The SFTP server rejected the configured authentication method.'; if (/timed out/i.test(error.message)) return 'The SFTP server did not respond before the connection timed out.'; return 'The SFTP connection could not be completed.'; }
