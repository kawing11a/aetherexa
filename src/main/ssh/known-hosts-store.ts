import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const storeSchema = z.object({ version: z.literal(1), fingerprints: z.record(z.string().uuid(), z.string().max(128)) }).strict();
export class KnownHostsStore {
  private readonly filePath = join(app.getPath('userData'), 'known-hosts.json');
  private writes: Promise<void> = Promise.resolve();
  async get(profileId: string, host: string, port: number): Promise<string | undefined> { return (await this.read()).fingerprints[endpointKey(profileId, host, port)]; }
  set(profileId: string, host: string, port: number, fingerprint: string): Promise<void> {
    return this.serialize(async () => { const data = await this.read(); data.fingerprints[endpointKey(profileId, host, port)] = fingerprint; await this.write(data); });
  }
  remove(profileId: string): Promise<void> {
    return this.serialize(async () => { const data = await this.read(); for (const key of Object.keys(data.fingerprints)) if (key === profileId || key.startsWith(profileId + '@')) delete data.fingerprints[key]; await this.write(data); });
  }
  private async read(): Promise<{ version: 1; fingerprints: Record<string, string> }> {
    try { const raw = await readFile(this.filePath, 'utf8'); const parsed = storeSchema.safeParse(JSON.parse(raw)); if (!parsed.success) throw new Error('invalid'); return parsed.data; }
    catch (error) { if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return { version: 1, fingerprints: {} }; throw new Error('The saved SSH host keys are unavailable.'); }
  }
  private async write(data: { version: 1; fingerprints: Record<string, string> }): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = this.filePath + '.' + randomUUID() + '.tmp';
    try { await writeFile(temp, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 }); await rename(temp, this.filePath); }
    catch { await rm(temp, { force: true }).catch(() => undefined); throw new Error('The SSH host key could not be saved.'); }
  }
  private serialize(operation: () => Promise<void>): Promise<void> { const pending = this.writes.then(operation); this.writes = pending.catch(() => undefined); return pending; }
}

function endpointKey(profileId: string, host: string, port: number): string { return `${profileId}@${host.trim().toLowerCase()}:${port}`; }
