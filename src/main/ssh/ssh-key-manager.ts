import { createHash, randomUUID } from 'node:crypto';
import { createPrivateKey } from 'node:crypto';
import { utils } from 'ssh2';
import type { ParsedKey } from 'ssh2';
import type { ProfileStore } from '@main/storage/profile-store.js';
import type { SecretStore } from '@main/storage/secret-store.js';
import { SshKeyStore } from '@main/storage/ssh-key-store.js';
import type { SshKeyRecord } from '@main/storage/ssh-key-store.js';

export type SshKeyMetadata = Pick<SshKeyRecord, 'fingerprint' | 'label' | 'algorithm' | 'publicKey' | 'createdAt'>;

export class SshKeyManager {
  constructor(private readonly store: SshKeyStore, private readonly secrets: SecretStore, private readonly profiles: ProfileStore) {}

  async list(): Promise<SshKeyMetadata[]> { return (await this.store.list()).map(toMetadata); }
  async hasKey(fingerprint: string): Promise<boolean> { return (await this.store.getByFingerprint(fingerprint)) !== undefined; }

  async importPrivateKey(input: { label: string; privateKey: Buffer; passphrase?: string }): Promise<SshKeyMetadata> {
    const parsed = utils.parseKey(input.privateKey, input.passphrase);
    if (parsed instanceof Error || Array.isArray(parsed) || !parsed.isPrivateKey()) throw new Error('The selected file is not a supported private key or its passphrase is incorrect.');
    return this.storeKey(input.label, parsed, input.privateKey, input.passphrase);
  }

  async generate(input: { label: string; algorithm: 'ed25519' | 'rsa'; passphrase?: string }): Promise<SshKeyMetadata> {
    const options = input.passphrase ? { passphrase: input.passphrase, cipher: 'aes256-cbc', rounds: 16 } : undefined;
    const pair = input.algorithm === 'ed25519'
      ? utils.generateKeyPairSync('ed25519', options)
      : utils.generateKeyPairSync('rsa', { ...(options ?? {}), bits: 4096 });
    const parsed = utils.parseKey(pair.private, input.passphrase);
    if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('The generated SSH key could not be parsed.');
    return this.storeKey(input.label, parsed, Buffer.from(pair.private), input.passphrase);
  }

  async rename(fingerprint: string, label: string): Promise<SshKeyMetadata> { return toMetadata(await this.store.rename(fingerprint, label)); }

  async changePassphrase(fingerprint: string, passphrase: string): Promise<void> {
    const record = await this.store.getByFingerprint(fingerprint);
    if (!record) throw new Error('The selected SSH key is unavailable.');
    const saved = await this.secrets.get(record.secretId);
    if (!saved?.privateKey) throw new Error('The selected SSH key is unavailable.');
    const parsed = utils.parseKey(Buffer.from(saved.privateKey, 'base64'), saved.passphrase);
    if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('The saved SSH key could not be decrypted.');
    const privateKey = createPrivateKey(parsed.getPrivatePEM());
    const output = passphrase
      ? privateKey.export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase })
      : privateKey.export({ format: 'pem', type: 'pkcs8' });
    await this.secrets.set(record.secretId, { privateKey: Buffer.from(output).toString('base64'), ...(passphrase ? { passphrase } : {}) });
  }

  async remove(fingerprint: string): Promise<void> {
    const profiles = await this.profiles.list();
    if (profiles.some((profile) => (profile.kind === 'ssh' || profile.kind === 'file-transfer' && 'keyFingerprint' in profile) && 'keyFingerprint' in profile && profile.keyFingerprint === fingerprint)) throw new Error('This key is used by a saved connection. Remove the profile reference before deleting the key.');
    const record = await this.store.remove(fingerprint);
    if (record) await this.secrets.remove(record.secretId);
  }

  async getPrivateKey(fingerprint: string): Promise<{ privateKey: Buffer; passphrase?: string }> {
    const record = await this.store.getByFingerprint(fingerprint);
    if (!record) throw new Error('The selected SSH key is unavailable.');
    const bundle = await this.secrets.get(record.secretId);
    if (!bundle?.privateKey) throw new Error('The selected SSH key is unavailable.');
    return { privateKey: Buffer.from(bundle.privateKey, 'base64'), ...(bundle.passphrase ? { passphrase: bundle.passphrase } : {}) };
  }

  private async storeKey(label: string, parsed: ParsedKey, privateKey: Buffer, passphrase?: string): Promise<SshKeyMetadata> {
    const publicBlob = parsed.getPublicSSH();
    const fingerprint = 'SHA256:' + createHash('sha256').update(publicBlob).digest('base64').replace(/=+$/, '');
    const algorithm = parsed.type === 'ssh-ed25519' ? 'ed25519' : parsed.type === 'ssh-rsa' ? 'rsa' : undefined;
    if (!algorithm) throw new Error('Only Ed25519 and RSA private keys are supported.');
    const publicKey = `${parsed.type} ${publicBlob.toString('base64')}${parsed.comment ? ` ${parsed.comment}` : ''}`;
    const id = randomUUID(); const secretId = randomUUID(); const createdAt = new Date().toISOString();
    await this.secrets.set(secretId, { privateKey: privateKey.toString('base64'), ...(passphrase ? { passphrase } : {}) });
    try {
      await this.store.save({ id, secretId, fingerprint, label: label.trim(), algorithm, publicKey, createdAt });
    } catch (error) { await this.secrets.remove(secretId).catch(() => undefined); throw error; }
    return { fingerprint, label: label.trim(), algorithm, publicKey, createdAt };
  }
}

function toMetadata(record: SshKeyRecord): SshKeyMetadata { return { fingerprint: record.fingerprint, label: record.label, algorithm: record.algorithm, publicKey: record.publicKey, createdAt: record.createdAt }; }
