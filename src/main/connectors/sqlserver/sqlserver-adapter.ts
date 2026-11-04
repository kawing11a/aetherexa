import sql from 'mssql';
import type { DatabaseProfile, SecretBundle } from '@shared/profiles';
import type { Result } from '@shared/contracts';
import type { ColumnDescriptor } from '@shared/database';
import { ConnectorError, capture, ok, normalizeConnectorError } from '../connector-errors.js';
import type { DatabaseAdapter, DatabaseSession, SqlSession } from '../contracts.js';
import { optionalDatabase, password, requiredHost, requiredPort, requiredUsername, tlsEnabled } from '../relational/connection-options.js';
import { BoundedPageBuilder } from '../relational/row-normalizer.js';

const capabilities = { namespaces: true, objects: true, queryMode: 'sql' as const, readRows: true, exportRows: true };
export class SqlServerAdapter implements DatabaseAdapter {
  readonly engine = 'sqlserver' as const;
  async connect(profile: DatabaseProfile, secrets: SecretBundle): Promise<Result<DatabaseSession>> {
    try {
          const pool = await new sql.ConnectionPool({ server: requiredHost(profile), port: requiredPort(profile, 1433), user: requiredUsername(profile), password: password(secrets), database: optionalDatabase(profile), connectionTimeout: 10_000, requestTimeout: 30_000, options: { encrypt: tlsEnabled(profile), trustServerCertificate: false, appName: 'Aetherexa' }, pool: { max: 2, min: 0, idleTimeoutMillis: 30_000 } }).connect();
      const session: SqlSession = {
        kind: 'sql', engine: this.engine, capabilities,
        async close() { await pool.close(); },
        async listNamespaces() { return capture(async () => { const result = await pool.request().query('SELECT s.name AS name FROM sys.schemas s ORDER BY s.name OFFSET 0 ROWS FETCH NEXT 10000 ROWS ONLY'); return result.recordset.map((row) => ({ name: String(row.name), kind: 'schema' as const })); }); },
        async listObjects(namespace) { return capture(async () => { const result = await pool.request().input('schema', sql.NVarChar(128), namespace).query("SELECT t.name AS name, CASE WHEN t.type = 'V' THEN 'view' ELSE 'table' END AS kind FROM sys.objects t JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE s.name=@schema AND t.type IN ('U','V') ORDER BY t.name OFFSET 0 ROWS FETCH NEXT 10000 ROWS ONLY"); return result.recordset.map((row) => ({ name: String(row.name), kind: row.kind === 'view' ? 'view' as const : 'table' as const })); }); },
        async runSql(queryText, limit, signal) {
          try {
            const request = pool.request();
            request.stream = true;
            let columns: ColumnDescriptor[] = [];
            let builder: BoundedPageBuilder | undefined;
            let truncated = false;
            const page = await new Promise<ReturnType<BoundedPageBuilder['finish']>>((resolve, reject) => {
              request.on('recordset', (metadata) => { const fields = metadata as Record<string, { type?: { name?: string } }>; columns = Object.entries(fields).map(([name, column]) => ({ name, typeHint: String(column.type?.name ?? '') })); builder = new BoundedPageBuilder(columns, limit); });
              request.on('row', (row) => { if (!truncated && builder && !builder.push(Object.values(row))) truncated = true; });
              request.on('error', reject);
              request.on('done', () => resolve((builder ?? new BoundedPageBuilder(columns, limit)).finish()));
              if (signal) signal.addEventListener('abort', () => request.cancel(), { once: true });
              request.query(queryText);
            });
            return ok(page);
          } catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
        },
      };
      return ok<DatabaseSession>(session);
    } catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
  }
}
