import { randomUUID } from 'node:crypto';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readdir, lstat, stat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { dialog, nativeImage } from 'electron';
import { TarArchive, ZipArchive } from 'archiver';
import type { BrowserWindow, WebContents } from 'electron';
import type { SFTPWrapper, Stats } from 'ssh2';
import type { Result } from '@shared/contracts';
import type { SftpDetails, SftpEntry, SftpLocalEntry, TransferProgress } from '@shared/database';
import type { SshSessionManager } from '../ssh/ssh-session-manager.js';
import { initialRemotePath, sftpErrorMessage } from './sftp-errors.js';

type SftpSession = { ownerId: number; sshSessionId: string; sftp: SFTPWrapper; initialPath: string };
type DragLease = { ownerId: number; path: string; timer: NodeJS.Timeout };
export class SftpSessionManager {
  private readonly sessions = new Map<string, SftpSession>();
  private readonly dragLeases = new Map<string, DragLease>();
  private readonly listedLocalFiles = new Map<number, Set<string>>();
  constructor(private readonly ssh: SshSessionManager) { void this.cleanupStaleDragExports(); }
  async open(ownerId: number, sshSessionId: string): Promise<Result<{ sftpId: string; initialPath: string }>> {
    const client = this.ssh.getClient(ownerId, sshSessionId);
    if (!client.ok) return client;
    return new Promise((resolve) => client.value.sftp(async (error, sftp) => {
      if (error) { resolve(failure('sftp-open-failed', 'The SFTP subsystem could not be opened.')); return; }
      let initialPath: string;
      try { initialPath = await initialRemotePath(sftp); } catch { sftp.end(); resolve(failure('sftp-open-failed', 'The SFTP connection closed while resolving the remote home directory.')); return; }
      const sftpId = randomUUID(); this.sessions.set(sftpId, { ownerId, sshSessionId, sftp, initialPath });
      client.value.once('close', () => { sftp.end(); this.sessions.delete(sftpId); });
      resolve({ ok: true, value: { sftpId, initialPath } });
    }));
  }
  async list(ownerId: number, id: string, inputPath: string): Promise<Result<SftpEntry[]>> {
    const found = this.owned(ownerId, id); if (!found.ok) return found;
    const path = validateRemotePath(inputPath); if (!path.ok) return path;
    return new Promise((resolve) => found.value.sftp.readdir(path.value, (error, items) => {
      if (error) { resolve(failure('sftp-list-failed', sftpErrorMessage('directory listing', path.value, error))); return; }
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
    const targetExists = await this.exists(found.value.sftp, target.value); if (!targetExists.ok) return targetExists;
    let remoteTarget = target.value;
    if (targetExists.value) {
      const targetAttrs = await this.remoteLstat(found.value.sftp, target.value); if (!targetAttrs.ok) return targetAttrs;
      if (targetAttrs.value.isDirectory()) remoteTarget = posix.join(target.value, basename(localPath));
      else if (remotePath.endsWith('/')) return failure('upload-target-invalid', 'The selected remote folder is not a directory.');
      else if (targetAttrs.value.isSymbolicLink()) return failure('upload-target-invalid', 'Uploads cannot replace a remote symbolic link.');
    }
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
    const remote = await this.remoteLstat(found.value.sftp, source.value); if (!remote.ok) return remote;
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

  async listLocal(ownerId: number, inputPath?: string): Promise<Result<{ path: string; entries: SftpLocalEntry[] }>> {
    const path = resolve(inputPath || homedir());
    try {
      const items = await readdir(path, { withFileTypes: true });
      const entries = await Promise.all(items.slice(0, 10_000).map(async (item) => {
        const fullPath = join(path, item.name); const attrs = await lstat(fullPath);
        return { name: item.name, path: fullPath, type: fileType(attrs as unknown as Stats), size: attrs.size, modifiedAt: attrs.mtimeMs, permissions: attrs.mode } satisfies SftpLocalEntry;
      }));
      const issued = this.listedLocalFiles.get(ownerId) ?? new Set<string>();
      for (const entry of entries) issued.add(entry.path);
      this.listedLocalFiles.set(ownerId, issued);
      return { ok: true, value: { path, entries } };
    } catch { return failure('local-list-failed', 'The local directory could not be listed.'); }
  }

  async chooseLocalDirectory(window: BrowserWindow): Promise<Result<string | null>> {
    const picked = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'], title: 'Choose local folder' });
    return { ok: true, value: picked.canceled ? null : picked.filePaths[0] ?? null };
  }

  async uploadPaths(ownerId: number, id: string, remoteDirectory: string, paths: string[], webContents: WebContents): Promise<Result<TransferProgress[]>> {
    const found = this.owned(ownerId, id); if (!found.ok) return found;
    const destination = validateRemotePath(remoteDirectory); if (!destination.ok) return destination;
    const output: TransferProgress[] = [];
    let count = 0;
    const uploadItem = async (local: string, remote: string, depth: number): Promise<void> => {
      if (depth > 64 || ++count > 10_000) throw new Error('The upload exceeded the directory limit.');
      const attrs = await lstat(local);
      if (attrs.isSymbolicLink()) throw new Error('Symbolic links are not uploaded.');
      if (attrs.isDirectory()) {
        const exists = await this.exists(found.value.sftp, remote); if (!exists.ok) throw new Error(exists.error.message);
        if (exists.value) throw new Error(`A remote item named ${basename(remote)} already exists.`);
        await new Promise<void>((resolveMkdir, rejectMkdir) => found.value.sftp.mkdir(remote, (error) => error ? rejectMkdir(error) : resolveMkdir()));
        for (const child of await readdir(local)) await uploadItem(join(local, child), posix.join(remote, child), depth + 1);
        return;
      }
      if (!attrs.isFile()) throw new Error(`Unsupported local item: ${basename(local)}.`);
      const exists = await this.exists(found.value.sftp, remote); if (!exists.ok) throw new Error(exists.error.message);
      if (exists.value) throw new Error(`A remote item named ${basename(remote)} already exists.`);
      let transferred = 0; const fileName = basename(local); const transferId = randomUUID();
      const send = (state: TransferProgress['state']) => { if (!webContents.isDestroyed()) webContents.send('sftp:transfer-progress', { transferId, direction: 'upload', fileName, transferredBytes: transferred, totalBytes: attrs.size, state } satisfies TransferProgress); };
      const meter = new Transform({ transform(chunk: Buffer, _encoding, done) { transferred += chunk.length; send('running'); done(null, chunk); } });
      await pipeline(createReadStream(local), meter, found.value.sftp.createWriteStream(remote, { flags: 'wx' }));
      send('completed'); output.push({ transferId, direction: 'upload', fileName, transferredBytes: attrs.size, totalBytes: attrs.size, state: 'completed' });
    };
    for (const localInput of paths) {
      const local = resolve(localInput);
      try { await uploadItem(local, posix.join(destination.value, basename(local)), 0); }
      catch (error) { return failure('transfer-failed', error instanceof Error ? error.message : `The item ${basename(local)} could not be uploaded.`); }
    }
    return { ok: true, value: output };
  }

  async downloadToDirectory(ownerId: number, id: string, remotePath: string, localDirectory: string, webContents: WebContents): Promise<Result<TransferProgress>> {
    const found = this.owned(ownerId, id); if (!found.ok) return found;
    const source = validateRemotePath(remotePath); if (!source.ok) return source;
    const destinationRoot = resolve(localDirectory); const rootAttrs = await stat(destinationRoot).catch(() => null);
    if (!rootAttrs?.isDirectory()) return failure('local-destination-invalid', 'Choose an existing local directory first.');
    const target = join(destinationRoot, basename(source.value)); const exists = await stat(target).then(() => true, () => false);
    if (exists) return failure('overwrite-confirmation-required', `A local item named ${basename(target)} already exists.`);
    const remote = await this.remoteLstat(found.value.sftp, source.value); if (!remote.ok) return remote;
    if (!remote.value.isFile() && !remote.value.isDirectory()) return failure('download-type-unsupported', 'This remote item cannot be downloaded.');
    const transferId = randomUUID(); const fileName = basename(source.value); let total = 0; let count = 0;
    const downloadTree = async (remotePathname: string, localPathname: string, depth: number): Promise<void> => {
      if (depth > 64 || ++count > 10_000) throw new Error('The download exceeded the directory limit.');
      const attrs = await this.remoteLstat(found.value.sftp, remotePathname);
      if (!attrs.ok) throw new Error(attrs.error.message);
      if (attrs.value.isDirectory()) {
        await mkdir(localPathname);
        const children = await new Promise<Array<{ filename: string; attrs: Stats }>>((resolveEntries, rejectEntries) => found.value.sftp.readdir(remotePathname, (error, values) => error ? rejectEntries(error) : resolveEntries(values)));
        for (const child of children) {
          if (child.filename === '.' || child.filename === '..') continue;
          if (!isSafeEntryName(child.filename)) throw new Error('The remote folder contains an invalid file name.');
          const childRemote = posix.join(remotePathname, child.filename); const childLocal = join(localPathname, child.filename);
          if (child.attrs.isSymbolicLink()) throw new Error('Symbolic links are not downloaded.');
          await downloadTree(childRemote, childLocal, depth + 1);
        }
        return;
      }
      if (!attrs.value.isFile()) throw new Error('Special remote files are not downloaded.');
      total += attrs.value.size;
      await new Promise<void>((resolveGet, rejectGet) => found.value.sftp.fastGet(remotePathname, localPathname, { step: (bytes) => {
        if (!webContents.isDestroyed()) webContents.send('sftp:transfer-progress', { transferId, direction: 'download', fileName: basename(remotePathname), transferredBytes: bytes, totalBytes: attrs.value.size, state: 'running' } satisfies TransferProgress);
      } }, (error) => error ? rejectGet(error) : resolveGet()));
    };
    try {
      await downloadTree(source.value, target, 0);
      const complete: TransferProgress = { transferId, direction: 'download', fileName, transferredBytes: total, totalBytes: total, state: 'completed' };
      if (!webContents.isDestroyed()) webContents.send('sftp:transfer-progress', complete);
      return { ok: true, value: complete };
    } catch { return failure('transfer-failed', `The item ${fileName} could not be downloaded completely. Remove any partial local folder before retrying.`); }
  }

  async details(ownerId: number, id: string, inputPath: string): Promise<Result<SftpDetails>> {
    const found = this.owned(ownerId, id); if (!found.ok) return found;
    const path = validateRemotePath(inputPath); if (!path.ok) return path;
    const attrs = await new Promise<Stats | null>((resolveStat) => found.value.sftp.lstat(path.value, (error, value) => resolveStat(error ? null : value)));
    if (!attrs) return failure('sftp-stat-failed', sftpErrorMessage('file details', path.value, new Error('The server did not return file attributes.')));
    return { ok: true, value: { name: basename(path.value), path: path.value, type: fileType(attrs), size: attrs.size, modifiedAt: attrs.mtime * 1000, permissions: attrs.mode, owner: attrs.uid, group: attrs.gid } };
  }

  async archive(ownerId: number, id: string, inputPath: string, format: 'zip' | 'tar' | 'tar.gz'): Promise<Result<void>> {
    const found = this.owned(ownerId, id); if (!found.ok) return found;
    const source = validateRemotePath(inputPath); if (!source.ok) return source;
    const attrs = await this.remoteLstat(found.value.sftp, source.value); if (!attrs.ok) return attrs;
    if (!attrs.value.isDirectory()) return failure('archive-source-invalid', 'Choose a remote directory to archive.');
    const extension = format === 'tar.gz' ? '.tar.gz' : `.${format}`;
    const target = source.value.replace(/\/$/, '') + extension;
    const exists = await this.exists(found.value.sftp, target); if (!exists.ok) return exists;
    if (exists.value) return failure('overwrite-confirmation-required', `An archive named ${basename(target)} already exists.`);
    const temporary = `${target}.aetherexa-${randomUUID()}.tmp`;
    const archive = format === 'zip' ? new ZipArchive() : new TarArchive(format === 'tar.gz' ? { gzip: true, gzipOptions: { level: 6 } } : {});
    const output = found.value.sftp.createWriteStream(temporary, { flags: 'wx' });
    const transfer = pipeline(archive, output);
    try {
      const files = await this.collectFiles(found.value.sftp, source.value);
      for (const file of files) archive.append(found.value.sftp.createReadStream(file.path), { name: file.relative });
      await archive.finalize(); await transfer;
      await new Promise<void>((resolveRename, reject) => found.value.sftp.rename(temporary, target, (error) => error ? reject(error) : resolveRename()));
      return { ok: true, value: undefined };
    } catch {
      archive.destroy(); output.destroy(); void new Promise<void>((resolveRemove) => found.value.sftp.unlink(temporary, () => resolveRemove()));
      return failure('archive-failed', 'The remote archive could not be created.');
    }
  }

  async prepareDrag(ownerId: number, id: string, inputPath: string): Promise<Result<{ dragId: string }>> {
    const found = this.owned(ownerId, id); if (!found.ok) return found;
    const source = validateRemotePath(inputPath); if (!source.ok) return source;
    const attrs = await this.remoteLstat(found.value.sftp, source.value); if (!attrs.ok) return attrs;
    if (!attrs.value.isFile() && !attrs.value.isDirectory()) return failure('drag-type-unsupported', 'This remote item cannot be dragged out.');
    const directory = await mkdtemp(join(tmpdir(), 'aetherexa-sftp-drag-'));
    const path = join(directory, basename(source.value));
    let count = 0;
    const stage = async (remotePathname: string, localPathname: string, depth: number): Promise<void> => {
      if (depth > 64 || ++count > 10_000) throw new Error('Drag export limit exceeded');
      const entry = await this.remoteLstat(found.value.sftp, remotePathname); if (!entry.ok) throw new Error(entry.error.message);
      if (entry.value.isDirectory()) {
        await mkdir(localPathname);
        const children = await new Promise<Array<{ filename: string; attrs: Stats }>>((resolveEntries, rejectEntries) => found.value.sftp.readdir(remotePathname, (error, values) => error ? rejectEntries(error) : resolveEntries(values)));
        for (const child of children) {
          if (child.filename === '.' || child.filename === '..') continue;
          if (!isSafeEntryName(child.filename) || child.attrs.isSymbolicLink()) throw new Error('Unsupported remote item in drag export');
          await stage(posix.join(remotePathname, child.filename), join(localPathname, child.filename), depth + 1);
        }
      } else if (entry.value.isFile()) await new Promise<void>((resolveGet, rejectGet) => found.value.sftp.fastGet(remotePathname, localPathname, (error) => error ? rejectGet(error) : resolveGet()));
      else throw new Error('Unsupported remote item in drag export');
    };
    try { await stage(source.value, path, 0); }
    catch { await rm(directory, { recursive: true, force: true }); return failure('drag-prepare-failed', 'The remote file could not be prepared for dragging.'); }
    const dragId = randomUUID(); const timer = setTimeout(() => { this.dragLeases.delete(dragId); void rm(directory, { recursive: true, force: true }); }, 24 * 60 * 60 * 1000); timer.unref();
    this.dragLeases.set(dragId, { ownerId, path, timer });
    return { ok: true, value: { dragId } };
  }

  async startDrag(ownerId: number, webContents: WebContents, input: { dragId?: string; localPath?: string }): Promise<Result<void>> {
    if (input.localPath && !this.listedLocalFiles.get(ownerId)?.has(resolve(input.localPath))) return failure('drag-source-unavailable', 'Choose the local file in the SFTP pane before dragging it.');
    const path = input.dragId ? this.dragLeases.get(input.dragId)?.ownerId === ownerId ? this.dragLeases.get(input.dragId)!.path : null : input.localPath ? resolve(input.localPath) : null;
    if (!path || webContents.isDestroyed()) return failure('drag-source-unavailable', 'The file is no longer available for dragging.');
    try { const attrs = await lstat(path); if (!attrs.isFile() && !attrs.isDirectory()) return failure('drag-type-unsupported', 'This item cannot be dragged out of the application.'); }
    catch { return failure('drag-source-unavailable', 'The file is no longer available for dragging.'); }
    try { webContents.startDrag({ file: path, icon: nativeImage.createEmpty() }); return { ok: true, value: undefined }; }
    catch { return failure('drag-start-failed', 'The operating system could not start the file drag.'); }
  }

  closeForSsh(ownerId: number, sshSessionId: string): void { for (const [id, session] of this.sessions) if (session.ownerId === ownerId && session.sshSessionId === sshSessionId) { session.sftp.end(); this.sessions.delete(id); } }
  closeProfile(profileId: string): void { for (const [id, session] of this.sessions) if (this.ssh.getProfileId(session.sshSessionId) === profileId) { session.sftp.end(); this.sessions.delete(id); } }
  closeOwner(ownerId: number): void { for (const [id, session] of this.sessions) if (session.ownerId === ownerId) { session.sftp.end(); this.sessions.delete(id); } this.listedLocalFiles.delete(ownerId); }
  closeAll(): void { for (const session of this.sessions.values()) session.sftp.end(); this.sessions.clear(); this.listedLocalFiles.clear(); }

  private owned(ownerId: number, id: string): Result<SftpSession> { const session = this.sessions.get(id); return session && session.ownerId === ownerId ? { ok: true, value: session } : failure('sftp-session-not-found', 'The SFTP session is closed or unavailable.'); }
  private exists(sftp: SFTPWrapper, path: string): Promise<Result<boolean>> { return new Promise((resolve) => sftp.lstat(path, (error) => { if (!error) resolve({ ok: true, value: true }); else if ('code' in error && error.code === 2) resolve({ ok: true, value: false }); else resolve(failure('sftp-stat-failed', 'The remote destination could not be checked safely.')); })); }
  private remoteLstat(sftp: SFTPWrapper, path: string): Promise<Result<Stats>> { return new Promise((resolve) => sftp.lstat(path, (error, value) => error || !value ? resolve(failure('sftp-stat-failed', 'The remote file could not be read.')) : resolve({ ok: true, value }))); }
  private async cleanupStaleDragExports(): Promise<void> {
    try {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const item of await readdir(tmpdir(), { withFileTypes: true })) {
        if (!item.isDirectory() || !item.name.startsWith('aetherexa-sftp-drag-')) continue;
        const path = join(tmpdir(), item.name); const attrs = await stat(path).catch(() => null);
        if (attrs && attrs.mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
      }
    } catch { /* Stale drag exports are best-effort cleanup; recent files are retained. */ }
  }
  private async collectFiles(sftp: SFTPWrapper, root: string): Promise<Array<{ path: string; relative: string }>> {
    const files: Array<{ path: string; relative: string }> = [];
    const visit = async (path: string, relative: string, depth: number): Promise<void> => {
      if (depth > 64 || files.length >= 10_000) throw new Error('Archive limit exceeded');
      const entries = await new Promise<Array<{ filename: string; attrs: Stats }>>((resolveEntries, reject) => sftp.readdir(path, (error, values) => error ? reject(error) : resolveEntries(values)));
      for (const entry of entries) {
        if (entry.filename === '.' || entry.filename === '..') continue;
        if (!isSafeEntryName(entry.filename)) throw new Error('The remote folder contains an invalid file name.');
        const child = posix.join(path, entry.filename); const childRelative = posix.join(relative, entry.filename);
        if (entry.attrs.isDirectory()) await visit(child, childRelative, depth + 1);
        else if (entry.attrs.isFile()) files.push({ path: child, relative: childRelative });
        else if (entry.attrs.isSymbolicLink()) throw new Error('Symbolic links are not followed');
      }
    };
    await visit(root, basename(root), 0); return files;
  }
}
function validateRemotePath(input: string): Result<string> { if (!input || input.includes('\0') || input.split('/').some((part) => part === '..')) return failure('invalid-path', 'The remote path is invalid.'); return { ok: true, value: posix.normalize(input) }; }
function fileType(attrs: Stats): SftpEntry['type'] { if (attrs.isDirectory()) return 'directory'; if (attrs.isFile()) return 'file'; if (attrs.isSymbolicLink()) return 'link'; return 'other'; }
function isSafeEntryName(name: string): boolean { return Boolean(name) && name !== '.' && name !== '..' && !/[\\/:<>"|?*\0]/.test(name) && !/[ .]$/.test(name); }
function callbackResult(operation: (callback: (error?: Error | null) => void) => void, code: string): Promise<Result<void>> { return new Promise((resolve) => operation((error) => resolve(error ? failure(code, 'The remote file operation could not be completed.') : { ok: true, value: undefined }))); }
function failure<T = never>(code: string, message: string): Result<T> { return { ok: false, error: { code, message, retryable: false } }; }

