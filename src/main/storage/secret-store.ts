import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { secretBundleSchema, type SecretBundle } from '@shared/profiles';
import { StorageError } from './storage-errors.js';

type SecretEnvelope = { version: 1; entries: Record<string, string> };

export class SecretStore {
  private readonly filePath = join(app.getPath('userData'), 'secrets.json');
  private writeChain: Promise<void> = Promise.resolve();

  async set(profileId: string, input: unknown, revision?: string): Promise<void> {
    const secrets = secretBundleSchema.parse(input);
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new StorageError('encryption-unavailable', 'Windows protected credential storage is unavailable.');
    }

    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(secrets));
    await this.serializeWrite(async () => {
      const envelope = await this.readEnvelope();
      envelope.entries[secretKey(profileId, revision)] = encrypted.toString('base64');
      await this.writeEnvelope(envelope);
    });
  }

  async get(profileId: string, revision?: string): Promise<SecretBundle | undefined> {
    const envelope = await this.readEnvelope();
    const key = secretKey(profileId, revision);
    const stored = envelope.entries[key];
    if (stored === undefined) return undefined;
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new StorageError('encryption-unavailable', 'Windows protected credential storage is unavailable.');
    }

    try {
      const decrypted = await safeStorage.decryptStringAsync(Buffer.from(stored, 'base64'));
      const secrets = secretBundleSchema.parse(JSON.parse(decrypted.result));
      if (decrypted.shouldReEncrypt) await this.set(profileId, secrets, revision);
      return secrets;
    } catch {
      throw new StorageError('corrupt-store', 'A saved credential could not be decrypted.');
    }
  }

  removeRevision(profileId: string, revision?: string): Promise<void> {
    return this.serializeWrite(async () => { const envelope = await this.readEnvelope(); delete envelope.entries[secretKey(profileId, revision)]; await this.writeEnvelope(envelope); });
  }

  remove(profileId: string): Promise<void> {
    return this.serializeWrite(async () => {
      const envelope = await this.readEnvelope();
      for (const key of Object.keys(envelope.entries)) if (key === profileId || key.startsWith(profileId + ':')) delete envelope.entries[key];
      await this.writeEnvelope(envelope);
    });
  }

  private async readEnvelope(): Promise<SecretEnvelope> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const envelope = secretEnvelopeSchema.safeParse(parsed);
      if (!envelope.success) throw new StorageError('corrupt-store', 'The local credential store is invalid.');
      return envelope.data;
    } catch (error) {
      if (isMissingFile(error)) return { version: 1, entries: {} };
      if (error instanceof StorageError) throw error;
      if (error instanceof SyntaxError) throw new StorageError('corrupt-store', 'The local credential store is unreadable.');
      throw error;
    }
  }

  private async writeEnvelope(envelope: SecretEnvelope): Promise<void> {
    try {
      await writeAtomicJson(this.filePath, envelope);
    } catch {
      throw new StorageError('write-failed', 'Credential changes could not be saved.');
    }
  }

  private serializeWrite(operation: () => Promise<void>): Promise<void> {
    const pending = this.writeChain.then(operation);
    this.writeChain = pending.catch(() => undefined);
    return pending;
  }
}

const secretEnvelopeSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?::[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i), z.string()),
}).strict();

async function writeAtomicJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function secretKey(profileId: string, revision?: string): string { return revision ? `${profileId}:${revision}` : profileId; }
