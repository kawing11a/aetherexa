import { randomUUID } from 'node:crypto';
import type { BrowserWindow, WebContents } from 'electron';
import type { Result } from '@shared/contracts';
import type { FileTransferProfile } from '@shared/profiles';
import type { FileSessionDescriptor, RemoteEntry } from '@shared/files';
import type { TransferProgress } from '@shared/database';
import type { ProfileStore } from '@main/storage/profile-store.js';
import type { SecretStore } from '@main/storage/secret-store.js';
import type { FileProvider, FileProviderSession } from './provider-contracts.js';
import type { SftpProvider } from './sftp-provider.js';

type OwnedSession = { ownerId: number; session: FileProviderSession; descriptor: FileSessionDescriptor };

export class FileSessionManager {
  private readonly sessions = new Map<string, OwnedSession>();
  constructor(private readonly profiles: ProfileStore, private readonly secrets: SecretStore, private readonly sftp: SftpProvider, private readonly ftp: FileProvider, private readonly s3: FileProvider) {}

  async connect(ownerId: number, profileId: string, window: BrowserWindow, webContents: WebContents): Promise<Result<FileSessionDescriptor>> {
    try {
      const profile = (await this.profiles.list()).find((item): item is FileTransferProfile => item.kind === 'file-transfer' && item.id === profileId);
      if (!profile) return fail('profile-not-found', 'The file-transfer profile could not be found.');
      const secrets = await this.secrets.get(profile.id, profile.secretRevision) ?? {};
      const provider: FileProvider = profile.protocol === 'sftp' ? this.sftp : profile.protocol === 's3' ? this.s3 : this.ftp;
      const connected = await provider.connect({ profile, secrets, ownerId, window, webContents });
      if (!connected.ok) return connected;
      const sessionId = randomUUID(); const descriptor = { sessionId, profileId, protocol: profile.protocol, host: profile.protocol === 's3' ? profile.bucket : 'host' in profile ? profile.host : '', initialPath: connected.value.initialPath ?? '/' };
      this.sessions.set(sessionId, { ownerId, session: connected.value, descriptor });
      return { ok: true, value: descriptor };
    } catch { return fail('file-connect-failed', 'The file-transfer connection could not be completed.'); }
  }

  async disconnect(ownerId: number, id: string): Promise<Result<void>> { const found = this.owned(ownerId, id); if (!found.ok) return found; found.value.session.close(); this.sessions.delete(id); return { ok: true, value: undefined }; }
  list(ownerId: number, id: string, path: string): Promise<Result<RemoteEntry[]>> { const found = this.owned(ownerId, id); return found.ok ? found.value.session.list(path) : Promise.resolve(found); }
  makeDirectory(ownerId: number, id: string, path: string): Promise<Result<void>> { const found = this.owned(ownerId, id); return found.ok ? found.value.session.makeDirectory(path) : Promise.resolve(found); }
  remove(ownerId: number, id: string, path: string, directory: boolean): Promise<Result<void>> { const found = this.owned(ownerId, id); return found.ok ? found.value.session.remove(path, directory) : Promise.resolve(found); }
  upload(ownerId: number, id: string, path: string): Promise<Result<TransferProgress>> { const found = this.owned(ownerId, id); return found.ok ? found.value.session.upload(path) : Promise.resolve(found); }
  download(ownerId: number, id: string, path: string): Promise<Result<TransferProgress>> { const found = this.owned(ownerId, id); return found.ok ? found.value.session.download(path) : Promise.resolve(found); }
  reviewHostKey(ownerId: number, requestId: string, accept: boolean, replaceChangedKey = false): Promise<Result<void>> { return this.sftp.reviewHostKey(ownerId, requestId, accept, replaceChangedKey); }
  closeProfile(profileId: string): void { this.sftp.closeProfile(profileId); for (const [id, value] of this.sessions) if (value.descriptor.profileId === profileId) { value.session.close(); this.sessions.delete(id); } }
  closeOwner(ownerId: number): void { this.sftp.closeOwner(ownerId); for (const [id, value] of this.sessions) if (value.ownerId === ownerId) { value.session.close(); this.sessions.delete(id); } }
  closeAll(): void { this.sftp.closeAll(); for (const value of this.sessions.values()) value.session.close(); this.sessions.clear(); }
  private owned(ownerId: number, id: string): Result<OwnedSession> { const value = this.sessions.get(id); return value && value.ownerId === ownerId ? { ok: true, value } : fail('file-session-not-found', 'The file-transfer session is closed or unavailable.'); }
}

function fail<T = never>(code: string, message: string): Result<T> { return { ok: false, error: { code, message, retryable: false } }; }
