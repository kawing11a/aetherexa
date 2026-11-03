import mysql from 'mysql2';
import type { Pool, PoolConnection, FieldPacket } from 'mysql2';
import type { DatabaseProfile, SecretBundle } from '@shared/profiles';
import type { Result } from '@shared/contracts';
import { ConnectorError, capture, ok, normalizeConnectorError } from '../connector-errors.js';
import type { DatabaseAdapter, DatabaseSession, SqlSession } from '../contracts.js';
import { optionalDatabase, password, requiredHost, requiredPort, requiredUsername, tlsEnabled } from '../relational/connection-options.js';
import { BoundedPageBuilder } from '../relational/row-normalizer.js';
import type { ColumnDescriptor } from '@shared/database';

const capabilities = { namespaces: true, objects: true, queryMode: 'sql' as const, readRows: true, exportRows: true };
export class MysqlAdapter implements DatabaseAdapter {
  readonly engine = 'mysql' as const;
  async connect(profile: DatabaseProfile, secrets: SecretBundle): Promise<Result<DatabaseSession>> {
    try {
      const pool = mysql.createPool({ host: requiredHost(profile), port: requiredPort(profile, 3306), user: requiredUsername(profile), password: password(secrets), database: optionalDatabase(profile), ssl: tlsEnabled(profile) ? { rejectUnauthorized: true } : undefined, waitForConnections: true, connectionLimit: 2, connectTimeout: 10_000, supportBigNumbers: true, bigNumberStrings: true });
      await new Promise<void>((resolve, reject) => pool.getConnection((error, connection) => { if (error) reject(error); else { connection.release(); resolve(); } }));
      const session: SqlSession = {
        kind: 'sql', engine: this.engine, capabilities,
        async close() { await new Promise<void>((resolve, reject) => pool.end((error) => error ? reject(error) : resolve())); },
        async listNamespaces() { return capture(async () => { const [rows] = await pool.promise().query('SELECT SCHEMA_NAME AS name FROM INFORMATION_SCHEMA.SCHEMATA ORDER BY SCHEMA_NAME LIMIT 10000'); return (rows as Record<string, unknown>[]).map((row) => ({ name: String(row.name), kind: 'schema' as const })); }); },
        async listObjects(namespace) { return capture(async () => { const [rows] = await pool.promise().execute('SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME LIMIT 10000', [namespace]); return (rows as Record<string, unknown>[]).map((row) => { return { name: String(row.name), kind: String(row.type).toUpperCase() === 'VIEW' ? 'view' as const : 'table' as const }; }); }); },
        async runSql(sql, limit, signal) {
          try {
            const connection = await new Promise<PoolConnection>((resolve, reject) => pool.getConnection((error, value) => error ? reject(error) : resolve(value)));
            try { return ok(await runStreamingQuery(connection, sql, limit, signal)); }
            finally { connection.release(); }
          } catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
        },
      };
      return ok<DatabaseSession>(session);
    } catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
  }
}

async function runStreamingQuery(connection: PoolConnection, sql: string, limit: number, signal?: AbortSignal) {
  const query = connection.query(sql);
  let fields: FieldPacket[] = [];
  query.on('fields', (value) => { fields = Array.isArray(value) ? value : [value]; });
  const stream = query.stream({ highWaterMark: 64 });
  if (signal) signal.addEventListener('abort', () => stream.destroy(new ConnectorError('cancelled', 'The query was cancelled.')), { once: true });
  let builder: BoundedPageBuilder | undefined;
  let stopped = false;
  for await (const raw of stream) {
    if (stopped) continue;
    const row = raw as Record<string, unknown>;
    const columns: ColumnDescriptor[] = fields.length
      ? fields.map((field) => ({ name: field.name, typeHint: String(field.columnType) }))
      : Object.keys(row).map((name) => ({ name, typeHint: null }));
    builder ??= new BoundedPageBuilder(columns, limit);
    const values = fields.length ? fields.map((field) => row[field.name]) : Object.values(row);
    if (!builder.push(values)) stopped = true;
  }
  if (signal?.aborted) throw new ConnectorError('cancelled', 'The query was cancelled.');
  return (builder ?? new BoundedPageBuilder(fields.map((field) => ({ name: field.name, typeHint: String(field.columnType) })), limit)).finish();
}
