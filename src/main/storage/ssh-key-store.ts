import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const recordSchema = z.object({
  id: z.string().uuid(),
  fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{20,}=?$/),
  label: z.string().trim().min(1).max(80),
  algorithm: z.enum(['ed25519', 'rsa']),
  publicKey: z.string().min(1).max(16384),
  createdAt: z.string().datetime(),
  secretId: z.string().uuid(),
}).strict();
const envelopeSchema = z.object({ version: z.literal(1), keys: z.array(recordSchema).max(1000) }).strict();
export type SshKeyRecord = z.infer<typeof recordSchema>;

export class SshKeyStore {
  private readonly filePath = join(app.getPath('userData'), 'ssh-keys.json');
  private writes: Promise<void> = Promise.resolve();

  async list(): Promise<SshKeyRecord[]> { return (await this.read()).keys; }
  async getByFingerprint(fingerprint: string): Promise<SshKeyRecord | undefined> { return (await this.read()).keys.find((key) => key.fingerprint === fingerprint); }
  save(record: SshKeyRecord): Promise<void> {
    const parsed = recordSchema.parse(record);
    return this.serialize(async () => { const data = await this.read(); if (data.keys.some((key) => key.fingerprint === parsed.fingerprint)) throw new Error('A key with this fingerprint already exists.'); data.keys.push(parsed); await this.write(data); });
  }
  rename(fingerprint: string, label: string): Promise<SshKeyRecord> {
    let updated: SshKeyRecord | undefined;
    return this.serialize(async () => { const data = await this.read(); const index = data.keys.findIndex((key) => key.fingerprint === fingerprint); if (index < 0) throw new Error('Key not found.'); updated = recordSchema.parse({ ...data.keys[index], label }); data.keys[index] = updated; await this.write(data); }).then(() => updated!);
  }
  remove(fingerprint: string): Promise<SshKeyRecord | undefined> {
    let removed: SshKeyRecord | undefined;
    return this.serialize(async () => { const data = await this.read(); const index = data.keys.findIndex((key) => key.fingerprint === fingerprint); if (index < 0) return; [removed] = data.keys.splice(index, 1); await this.write(data); }).then(() => removed);
  }

  private async read(): Promise<{ version: 1; keys: SshKeyRecord[] }> {
    try { const parsed = envelopeSchema.safeParse(JSON.parse(await readFile(this.filePath, 'utf8'))); if (!parsed.success) throw new Error('invalid'); return parsed.data; }
    catch (error) { if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return { version: 1, keys: [] }; throw new Error('The local SSH key list is unavailable.'); }
  }
  private async write(data: { version: 1; keys: SshKeyRecord[] }): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true }); const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 }); await rename(temporary, this.filePath); }
    catch { await rm(temporary, { force: true }).catch(() => undefined); throw new Error('The SSH key list could not be saved.'); }
  }
  private serialize(operation: () => Promise<void>): Promise<void> { const pending = this.writes.then(operation); this.writes = pending.catch(() => undefined); return pending; }
}
