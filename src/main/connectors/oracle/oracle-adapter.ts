import oracledb from 'oracledb';
import type { DatabaseProfile, SecretBundle } from '@shared/profiles';
import type { Result } from '@shared/contracts';
import type { ColumnDescriptor } from '@shared/database';
import { ConnectorError, capture, ok, normalizeConnectorError } from '../connector-errors.js';
import type { DatabaseAdapter, DatabaseSession, SqlSession } from '../contracts.js';
import { password, requiredHost, requiredPort, requiredUsername, tlsEnabled } from '../relational/connection-options.js';
import { BoundedPageBuilder } from '../relational/row-normalizer.js';

const capabilities = { namespaces: true, objects: true, queryMode: 'sql' as const, readRows: true, exportRows: true };
export class OracleAdapter implements DatabaseAdapter {
  readonly engine = 'oracle' as const;
  async connect(profile: DatabaseProfile, secrets: SecretBundle): Promise<Result<DatabaseSession>> {
    try {
      const host = requiredHost(profile);
      const port = requiredPort(profile, 1521);
      const service = typeof profile.options.database === 'string' && profile.options.database.trim() ? profile.options.database.trim() : 'ORCL';
      const protocol = tlsEnabled(profile) ? 'tcps' : 'tcp';
      const connection = await oracledb.getConnection({ user: requiredUsername(profile), password: password(secrets), connectString: protocol + '://' + host + ':' + port + '/' + service });
      connection.callTimeout = 30_000;
      const session: SqlSession = {
        kind: 'sql', engine: this.engine, capabilities,
        async close() { await connection.close(); },
        async listNamespaces() { return capture(async () => { const result = await connection.execute('SELECT username AS name FROM all_users ORDER BY username FETCH FIRST 10000 ROWS ONLY', [], { outFormat: oracledb.OUT_FORMAT_OBJECT }); return objectRows(result.rows).map((row) => ({ name: String(row.NAME ?? row.name), kind: 'schema' as const })); }); },
        async listObjects(namespace) { return capture(async () => { const result = await connection.execute("SELECT table_name AS name, 'table' AS kind FROM all_tables WHERE owner = :owner UNION ALL SELECT view_name AS name, 'view' AS kind FROM all_views WHERE owner = :owner ORDER BY name FETCH FIRST 10000 ROWS ONLY", { owner: namespace.toUpperCase() }, { outFormat: oracledb.OUT_FORMAT_OBJECT }); return objectRows(result.rows).map((row) => ({ name: String(row.NAME ?? row.name), kind: String(row.KIND ?? row.kind) === 'view' ? 'view' as const : 'table' as const })); }); },
        async runSql(sqlText, limit, signal) {
          let resultSet: oracledb.ResultSet<unknown> | undefined;
          const abort = () => { void connection.break().catch(() => undefined); };
          try {
            if (signal?.aborted) throw new ConnectorError('cancelled', 'The query was cancelled.');
            signal?.addEventListener('abort', abort, { once: true });
            const result = await connection.execute(sqlText, [], { resultSet: true, outFormat: oracledb.OUT_FORMAT_OBJECT, fetchArraySize: 256, autoCommit: true });
            resultSet = result.resultSet;
            const columns: ColumnDescriptor[] = (result.metaData ?? []).map((field) => ({ name: field.name, typeHint: String(field.dbTypeName ?? '') }));
            const builder = new BoundedPageBuilder(columns, limit);
            if (resultSet) {
              while (true) {
                const rows = await resultSet.getRows(256) as Record<string, unknown>[];
                if (!rows.length) break;
                for (const row of rows) if (!builder.push(columns.map((column) => row[column.name]))) return ok({ ...builder.finish(), ...(result.rowsAffected === undefined ? {} : { affectedRows: result.rowsAffected }) });
                if (signal?.aborted) throw new ConnectorError('cancelled', 'The query was cancelled.');
              }
            }
            return ok({ ...builder.finish(), ...(result.rowsAffected === undefined ? {} : { affectedRows: result.rowsAffected }) });
          } catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
          finally {
            signal?.removeEventListener('abort', abort);
            await resultSet?.close().catch(() => undefined);
          }
        },
      };
      return ok<DatabaseSession>(session);
    } catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
  }
}
function objectRows(rows: unknown): Record<string, unknown>[] { return Array.isArray(rows) ? rows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null) : []; }

