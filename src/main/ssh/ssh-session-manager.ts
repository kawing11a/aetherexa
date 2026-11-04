import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ssh2 from 'ssh2';
import type { Client as SshClient, ConnectConfig } from 'ssh2';
import type { WebContents } from 'electron';
import type { SshSessionDescriptor, HostKeyNotice } from '@shared/database';
import type { ConnectionProfile, SshProfile } from '@shared/profiles';
import type { Result } from '@shared/contracts';
import type { ProfileStore } from '../storage/profile-store.js';
import type { SecretStore } from '../storage/secret-store.js';
import { KnownHostsStore } from './known-hosts-store.js';
import type { SshKeyManager } from './ssh-key-manager.js';

const { Client } = ssh2;

type Session = { ownerId: number; profileId: string; client: SshClient; webContents: WebContents; descriptor: SshSessionDescriptor };
type PendingTrust = { ownerId: number; profileId: string; host: string; port: number; client: SshClient; fingerprint: string; changed: boolean; verify(valid: boolean): void; timer: NodeJS.Timeout };
export class SshSessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly pendingTrust = new Map<string, PendingTrust>();
  constructor(private readonly profiles: ProfileStore, private readonly secrets: SecretStore, private readonly knownHosts: KnownHostsStore, private readonly sshKeys: SshKeyManager) {}

  async connect(ownerId: number, profileId: string, webContents: WebContents): Promise<Result<SshSessionDescriptor>> {
    try {
      const allProfiles = await this.profiles.list();
      const profile = allProfiles.find((item): item is SshProfile => item.id === profileId && item.kind === 'ssh');
      if (!profile) return failure('profile-not-found', 'The SSH profile could not be found.');
      const secrets = await this.secrets.get(profileId, profile.secretRevision) ?? {};
      const config = await this.buildConfig(profile, secrets);
      const client = new Client();
      config.hostVerifier = (key: Buffer, verify: (valid: boolean) => void) => { void this.verifyHost(ownerId, profile, client, webContents, key, verify); };
      return await new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => { if (!settled) { settled = true; client.end(); resolve(failure('timeout', 'The SSH server did not respond before the connection timed out.', true)); } }, 100_000);
        client.once('ready', () => {
          if (settled) { client.end(); return; }
          settled = true; clearTimeout(timer);
          const sessionId = randomUUID();
          const descriptor = { sessionId, profileId, host: profile.host, port: profile.port };
          this.sessions.set(sessionId, { ownerId, profileId, client, webContents, descriptor });
          client.once('close', () => { this.sessions.delete(sessionId); this.rejectPendingForClient(client); if (!webContents.isDestroyed()) webContents.send('ssh:disconnected', { sessionId, message: 'The SSH connection closed.' }); });
          resolve({ ok: true, value: descriptor });
        });
        client.on('error', (error) => { if (settled) return; settled = true; clearTimeout(timer); client.end(); resolve(failure('ssh-connect-failed', safeSshMessage(error), false)); });
        client.once('close', () => this.rejectPendingForClient(client));
        try { client.connect(config); } catch (error) { settled = true; clearTimeout(timer); client.end(); resolve(failure('ssh-connect-failed', safeSshMessage(error), false)); }
      });
    } catch (error) { return failure('ssh-connect-failed', safeSshMessage(error), false); }
  }

  async reviewHostKey(ownerId: number, requestId: string, accept: boolean, replaceChangedKey = false): Promise<Result<void>> {
    const pending = this.pendingTrust.get(requestId);
    if (!pending || pending.ownerId !== ownerId) return failure('host-key-review-expired', 'The SSH host key review is no longer active.');
    clearTimeout(pending.timer);
    this.pendingTrust.delete(requestId);
    if (!accept) { pending.verify(false); return { ok: true, value: undefined }; }
    try {
      if (pending.changed && !replaceChangedKey) { pending.verify(false); return failure('host-key-replacement-required', 'Confirm that you reviewed the changed host key before saving it.'); }
      await this.knownHosts.set(pending.profileId, pending.host, pending.port, pending.fingerprint);
      pending.verify(true);
      return { ok: true, value: undefined };
    } catch { pending.verify(false); return failure('host-key-save-failed', 'The SSH host key could not be saved.'); }
  }

  getProfileId(sessionId: string): string | undefined { return this.sessions.get(sessionId)?.profileId; }
  getClient(ownerId: number, sessionId: string): Result<SshClient> {
    const session = this.sessions.get(sessionId);
    return session && session.ownerId === ownerId ? { ok: true, value: session.client } : failure('ssh-session-not-found', 'The SSH session is closed or unavailable.');
  }
  async disconnect(ownerId: number, sessionId: string): Promise<Result<void>> {
    const session = this.sessions.get(sessionId);
    if (!session || session.ownerId !== ownerId) return failure('ssh-session-not-found', 'The SSH session is closed or unavailable.');
    this.sessions.delete(sessionId);
    session.client.end();
    return { ok: true, value: undefined };
  }
  async closeOwner(ownerId: number): Promise<void> {
    for (const [id, pending] of this.pendingTrust) if (pending.ownerId === ownerId) { clearTimeout(pending.timer); pending.verify(false); this.pendingTrust.delete(id); }
    for (const [id, session] of this.sessions) if (session.ownerId === ownerId) { this.sessions.delete(id); session.client.end(); }
  }
  async closeProfile(profileId: string): Promise<void> {
    for (const [id, pending] of this.pendingTrust) if (pending.profileId === profileId) { clearTimeout(pending.timer); pending.verify(false); this.pendingTrust.delete(id); }
    for (const [id, session] of this.sessions) if (session.profileId === profileId) { this.sessions.delete(id); session.client.end(); }
  }
  async closeAll(): Promise<void> {
    for (const [id, pending] of this.pendingTrust) { clearTimeout(pending.timer); pending.verify(false); this.pendingTrust.delete(id); }
    for (const session of this.sessions.values()) session.client.end(); this.sessions.clear();
  }

  private rejectPendingForClient(client: SshClient): void { for (const [id, pending] of this.pendingTrust) if (pending.client === client) { clearTimeout(pending.timer); pending.verify(false); this.pendingTrust.delete(id); } }

  private async buildConfig(profile: SshProfile, secrets: Record<string, string>): Promise<ConnectConfig> {
    const base: ConnectConfig = { host: profile.host, port: profile.port, username: profile.username, readyTimeout: 90_000, keepaliveInterval: 15_000, keepaliveCountMax: 3 };
    if (profile.authentication === 'password') {
      if (!secrets.password) throw new Error('The saved password is missing.');
      return { ...base, password: secrets.password };
    }
    if (profile.authentication === 'private-key-file') {
      if (profile.keyFingerprint) {
        const key = await this.sshKeys.getPrivateKey(profile.keyFingerprint);
        return { ...base, privateKey: key.privateKey, ...(key.passphrase ? { passphrase: key.passphrase } : {}) };
      }
      if (!profile.privateKeyPath) throw new Error('The private key path is missing.');
      const key = await readFile(profile.privateKeyPath);
      return { ...base, privateKey: key, ...(secrets.passphrase ? { passphrase: secrets.passphrase } : {}) };
    }
    const agent = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? 'pageant' : undefined);
    if (!agent) throw new Error('No SSH agent is available.');
    return { ...base, agent };
  }

  private async verifyHost(ownerId: number, profile: SshProfile, client: SshClient, webContents: WebContents, key: Buffer, verify: (valid: boolean) => void): Promise<void> {
    const fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
    try {
      const previousFingerprint = await this.knownHosts.get(profile.id, profile.host, profile.port) ?? null;
      if (previousFingerprint === fingerprint) { verify(true); return; }
      const requestId = randomUUID();
      const changed = previousFingerprint !== null;
      const timer = setTimeout(() => {
        this.pendingTrust.delete(requestId);
        verify(false);
      }, 60_000);
      this.pendingTrust.set(requestId, { ownerId, profileId: profile.id, host: profile.host, port: profile.port, client, fingerprint, changed, verify, timer });
      const notice: HostKeyNotice = { requestId, profileId: profile.id, host: profile.host, port: profile.port, currentFingerprint: fingerprint, previousFingerprint, changed };
      if (webContents.isDestroyed()) { clearTimeout(timer); this.pendingTrust.delete(requestId); verify(false); return; }
      webContents.send('ssh:host-key', notice);
    } catch { verify(false); }
  }
}

function failure<T = never>(code: string, message: string, retryable = false): Result<T> { return { ok: false, error: { code, message, retryable } }; }
function safeSshMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'The SSH connection could not be completed.';
  if (/authentication/i.test(error.message)) return 'The SSH server rejected the configured authentication method.';
  if (/timed out/i.test(error.message)) return 'The SSH server did not respond before the connection timed out.';
  if (/host key|fingerprint/i.test(error.message)) return 'The SSH host key was not accepted.';
  return 'The SSH connection could not be completed.';
}









