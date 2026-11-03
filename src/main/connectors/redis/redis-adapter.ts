import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import type { DatabaseProfile, SecretBundle } from '@shared/profiles';
import type { Result } from '@shared/contracts';
import type { KeyPage, RedisReply } from '@shared/database';
import { ConnectorError, ok, normalizeConnectorError } from '../connector-errors.js';
import type { DatabaseAdapter, DatabaseSession, RedisSession } from '../contracts.js';
import { password, requiredHost, requiredPort, requiredUsername, tlsEnabled } from '../relational/connection-options.js';
import { normalizeValue } from '../relational/row-normalizer.js';
import { MAX_PAGE_BYTES, MAX_RESULT_ROWS, MAX_REDIS_COMMAND_BYTES } from '../contracts.js';

const capabilities = { namespaces: false, objects: false, queryMode: 'redis-command' as const, readRows: true, exportRows: false };
export class RedisAdapter implements DatabaseAdapter {
  readonly engine = 'redis' as const;
  async connect(profile: DatabaseProfile, secrets: SecretBundle): Promise<Result<DatabaseSession>> {
    try {
      const host = requiredHost(profile);
      const port = requiredPort(profile, 6379);
      const socket = tlsEnabled(profile) ? { host, port, tls: true as const, rejectUnauthorized: true, connectTimeout: 10_000 } : { host, port, connectTimeout: 10_000 };
      const username = typeof profile.options.username === 'string' && profile.options.username.trim() ? profile.options.username.trim() : undefined;
      const client = createClient({ socket: { ...socket, reconnectStrategy: false }, username, password: password(secrets), database: Number(profile.options.database ?? 0), disableOfflineQueue: true });
      client.on('error', () => undefined);
      await client.connect();
      const pendingScans = new Map<string, { pattern: string; serverCursor: string; keys: string[] }>();
      const session: RedisSession = {
        kind: 'redis', engine: this.engine, capabilities,
        async close() { if (client.isOpen) await client.quit(); },
        async scanKeys(pattern, cursor, count, signal) {
          try {
            if (signal?.aborted) throw new ConnectorError('cancelled', 'The request was cancelled.');
            let serverCursor = '0';
            let keys: string[];
            const normalizedPattern = pattern || '*';
            if (cursor === '0') {
              const scanned = await client.scan('0', { MATCH: normalizedPattern, COUNT: Math.min(count, 1000) });
              serverCursor = scanned.cursor; keys = scanned.keys;
            } else {
              const pending = pendingScans.get(cursor);
              if (!pending) throw new ConnectorError('invalid-cursor', 'The Redis scan cursor expired. Start a new scan.');
              if (pending.pattern !== normalizedPattern) throw new ConnectorError('invalid-cursor', 'The scan pattern changed. Start a new scan.');
              pendingScans.delete(cursor);
              if (pending.keys.length) { serverCursor = pending.serverCursor; keys = pending.keys; }
              else { const scanned = await client.scan(pending.serverCursor, { MATCH: normalizedPattern, COUNT: Math.min(count, 1000) }); serverCursor = scanned.cursor; keys = scanned.keys; }
            }
            const page: string[] = [];
            let pageBytes = 0;
            while (keys.length && page.length < MAX_RESULT_ROWS) {
              const next = keys[0]; const bytes = new TextEncoder().encode(next).byteLength;
              if (bytes > MAX_PAGE_BYTES && page.length === 0) throw new ConnectorError('result-too-large', 'A Redis key exceeds the safe display limit.');
              if (pageBytes + bytes > MAX_PAGE_BYTES) break;
              keys.shift(); page.push(next); pageBytes += bytes;
            }
            let nextCursor: string | null;
            if (keys.length || serverCursor !== '0') {
              if (pendingScans.size >= 1024) pendingScans.delete(pendingScans.keys().next().value!);
              nextCursor = randomUUID(); pendingScans.set(nextCursor, { pattern: normalizedPattern, serverCursor, keys });
            } else nextCursor = null;
            return ok<KeyPage>({ keys: page, nextCursor });
          } catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
        },
        async executeCommand(tokens, signal) {
          try {
            if (signal?.aborted) throw new ConnectorError('cancelled', 'The request was cancelled.');
            const command = tokens[0]?.toUpperCase();
            if (command === 'AUTH' || (command === 'HELLO' && tokens.some((token) => token.toUpperCase() === 'AUTH')) || (command === 'CONFIG' && tokens.some((token) => token.toUpperCase() === 'REQUIREPASS'))) throw new ConnectorError('invalid-input', 'Use the saved connection credentials for Redis authentication.');
            if (tokens.reduce((sum, token) => sum + new TextEncoder().encode(token).byteLength, 0) > MAX_REDIS_COMMAND_BYTES) throw new ConnectorError('invalid-input', 'The Redis command exceeds the size limit.');
            const value = normalizeValue(await client.sendCommand(tokens));
            const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
            if (bytes > MAX_PAGE_BYTES) throw new ConnectorError('result-too-large', 'The Redis response exceeds the display limit.');
            const kind = Array.isArray(value) ? 'array' : value && typeof value === 'object' ? 'map' : 'scalar';
            return ok<RedisReply>({ kind, value });
          } catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
        },
      };
      return ok<DatabaseSession>(session);
    } catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
  }
}


