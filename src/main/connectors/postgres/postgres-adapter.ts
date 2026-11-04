import { Pool } from 'pg';
import Cursor from 'pg-cursor';
import type { DatabaseProfile, SecretBundle } from '@shared/profiles';
import type { Result } from '@shared/contracts';
import { capture, normalizeConnectorError, ok } from '../connector-errors.js';
import type { DatabaseAdapter, DatabaseSession, SqlSession } from '../contracts.js';
import { optionalDatabase, password, requiredHost, requiredPort, requiredUsername, tlsEnabled } from '../relational/connection-options.js';
import { BoundedPageBuilder } from '../relational/row-normalizer.js';
import type { ColumnDescriptor } from '@shared/database';

const capabilities = { namespaces: true, objects: true, queryMode: 'sql' as const, readRows: true, exportRows: true };
export class PostgresAdapter implements DatabaseAdapter {
  readonly engine = 'postgres' as const;
  async connect(profile: DatabaseProfile, secrets: SecretBundle): Promise<Result<DatabaseSession>> {
    try {
          const pool = new Pool({ host: requiredHost(profile), port: requiredPort(profile, 5432), user: requiredUsername(profile), password: password(secrets), database: optionalDatabase(profile) ?? 'postgres', ssl: tlsEnabled(profile) ? { rejectUnauthorized: true } : false, connectionTimeoutMillis: 10_000, statement_timeout: 30_000, application_name: 'Aetherexa' });
      const client = await pool.connect(); client.release();
      const session: SqlSession = {
        kind: 'sql', engine: this.engine, capabilities,
        async close() { await pool.end(); },
        async listNamespaces() { return capture(async () => { const result = await pool.query("SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema', 'pg_catalog') ORDER BY schema_name LIMIT 10000"); return result.rows.map((row) => ({ name: String(row.name), kind: 'schema' as const })); }); },
        async listObjects(namespace) { return capture(async () => { const result = await pool.query('SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name LIMIT 10000', [namespace]); return result.rows.map((row) => ({ name: String(row.name), kind: String(row.type).toUpperCase() === 'VIEW' ? 'view' as const : 'table' as const })); }); },
        async runSql(sql, limit, signal) {
          let client;
          let cursor: Cursor<unknown[]> | undefined;
          try {
            client = await pool.connect();
            cursor = client.query(new Cursor(sql, [], { rowMode: 'array' }));
            const initial = await readCursor(cursor, 1);
            const columns: ColumnDescriptor[] = initial.fields.map((field) => ({ name: field.name, typeHint: String(field.dataTypeID) }));
            const builder = new BoundedPageBuilder(columns, limit);
            let rows = initial.rows;
            while (rows.length) {
              for (const row of rows) if (!builder.push(row)) { await cursor.close(); return ok(builder.finish()); }
              if (signal?.aborted) throw new Error('cancelled');
              const batch = await readCursor(cursor, Math.min(256, Math.max(1, limit - builder.finish().rows.length + 1)));
              rows = batch.rows;
            }
            await cursor.close();
            return ok(builder.finish());
          } catch (error) { await cursor?.close().catch(() => undefined); return { ok: false, error: normalizeConnectorError(error) }; }
          finally { client?.release(); }
        },
      };
      return ok<DatabaseSession>(session);
    } catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
  }
}
function readCursor(cursor: Cursor<unknown[]>, count: number): Promise<{ rows: unknown[][]; fields: { name: string; dataTypeID: number }[] }> {
  return new Promise((resolve, reject) => cursor.read(count, (error, rows, result) => error ? reject(error) : resolve({ rows: rows ?? [], fields: result?.fields ?? [] })));
}
