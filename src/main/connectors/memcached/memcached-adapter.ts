import memjs from 'memjs';
import type { Client } from 'memjs';
import type { DatabaseProfile, SecretBundle } from '@shared/profiles';
import type { Result } from '@shared/contracts';
import type { MemcachedSetInput, MemcachedValue } from '@shared/database';
import { ConnectorError, ok, normalizeConnectorError } from '../connector-errors.js';
import type { DatabaseAdapter, DatabaseSession, MemcachedSession } from '../contracts.js';
import { password, requiredHost, requiredPort, requiredUsername } from '../relational/connection-options.js';
import { MAX_CELL_BYTES } from '../contracts.js';

const capabilities = { namespaces: false, objects: false, queryMode: 'memcached-key' as const, readRows: true, exportRows: false };
export class MemcachedAdapter implements DatabaseAdapter {
  readonly engine = 'memcached' as const;
  async connect(profile: DatabaseProfile, secrets: SecretBundle): Promise<Result<DatabaseSession>> {
    try {
      if (profile.options.tls !== false) throw new ConnectorError('unsupported-feature', 'The selected Memcached client does not support TLS. Turn off TLS for this connection.');
      const host = requiredHost(profile);
      const port = requiredPort(profile, 11211);
      const username = typeof profile.options.username === 'string' ? profile.options.username : undefined;
      const client: Client<Buffer, Buffer> = memjs.Client.create(host + ':' + port, { username, password: password(secrets), retries: 0, logger: { log() {} }, timeout: 2, conntimeout: 5 });
      const session: MemcachedSession = {
        kind: 'memcached', engine: this.engine, capabilities,
        async close() { client.close(); },
        async getStats() {
          try {
            return await new Promise((resolve, reject) => {
              const values: Record<string, string> = {};
              let completed = 0;
              const expected = client.servers.length;
              if (expected === 0) { resolve(ok(values)); return; }
              client.stats((error, server, stats) => {
                completed++;
                if (error) { if (completed === expected) reject(error); return; }
                for (const [key, value] of Object.entries(stats ?? {})) values[server + ' ' + key] = value;
                if (completed === expected) resolve(ok(values));
              });
            });
          } catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
        },
        async getValue(key) {
          try {
            const result = await client.get(key);
            if (result.value === null) return ok<MemcachedValue | null>(null);
            const value = new Uint8Array(result.value);
            if (value.byteLength > MAX_CELL_BYTES) throw new ConnectorError('result-too-large', 'The Memcached value exceeds the 1 MiB display limit.');
            const flags = result.flags ? result.flags.readUInt32BE(0) : 0;
            return ok<MemcachedValue>({ value, flags, bytes: value.byteLength });
          } catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
        },
        async setValue(input: MemcachedSetInput) {
          try {
            const value = typeof input.value === 'string' ? Buffer.from(input.value, 'utf8') : Buffer.from(input.value);
            if (value.byteLength > MAX_CELL_BYTES) throw new ConnectorError('invalid-input', 'The Memcached value exceeds the 1 MiB limit.');
            if (!await client.set(input.key, value, { expires: input.ttlSeconds })) throw new ConnectorError('write-failed', 'The Memcached server did not store the value.');
            return ok(undefined);
          } catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
        },
        async deleteValue(key) {
          try { if (!await client.delete(key)) throw new ConnectorError('not-found', 'The Memcached key was not found.'); return ok(undefined); }
          catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
        },
      };
      return ok<DatabaseSession>(session);
    } catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
  }
}
