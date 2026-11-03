import sqlite3 from 'sqlite3';
import type { DatabaseProfile, SecretBundle } from '@shared/profiles';
import type { Result } from '@shared/contracts';
import type { QueryPage } from '@shared/database';
import { ConnectorError, ok, normalizeConnectorError } from '../connector-errors.js';
import type { DatabaseAdapter, DatabaseSession, SqlSession } from '../contracts.js';
import { sqlitePath } from '../relational/connection-options.js';
import { BoundedPageBuilder } from '../relational/row-normalizer.js';

const capabilities = { namespaces: true, objects: true, queryMode: 'sql' as const, readRows: true, exportRows: true };
export class SqliteAdapter implements DatabaseAdapter {
  readonly engine = 'sqlite' as const;
  async connect(profile: DatabaseProfile, _secrets: SecretBundle): Promise<Result<DatabaseSession>> {
    try {
      const path = sqlitePath(profile);
      const database = await new Promise<sqlite3.Database>((resolve, reject) => {
        const handle = new sqlite3.Database(path, sqlite3.OPEN_READWRITE | sqlite3.OPEN_FULLMUTEX, (error) => error ? reject(error) : resolve(handle));
      });
      const session: SqlSession = {
        kind: 'sql', engine: this.engine, capabilities,
        async close() { await new Promise<void>((resolve, reject) => database.close((error) => error ? reject(error) : resolve())); },
        async listNamespaces(signal) { return runRows(database, 'PRAGMA database_list', [], signal).then((result) => result.ok ? ok(result.value.rows.map((row) => ({ name: String(row[1]), kind: 'database' as const }))) : result); },
        async listObjects(namespace, signal) {
          if (!['main', 'temp'].includes(namespace)) return { ok: false, error: { code: 'invalid-input', message: 'Choose a listed SQLite database.', retryable: false } };
          return runRows(database, "SELECT name, type FROM " + namespace + ".sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 10000", [], signal).then((result) => result.ok ? ok(result.value.rows.map((row) => ({ name: String(row[0]), kind: String(row[1]) === 'view' ? 'view' as const : 'table' as const }))) : result);
        },
        async runSql(sql, limit, signal) { return runRows(database, sql, [], signal, limit); },
      };
      return ok<DatabaseSession>(session);
    } catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
  }
}

function runRows(database: sqlite3.Database, sql: string, params: unknown[], signal?: AbortSignal, limit = 10_000): Promise<Result<QueryPage>> {
  return new Promise((resolve, reject) => {
    let columns: { name: string; typeHint: string | null }[] = [];
    let builder: BoundedPageBuilder | undefined;
    let truncated = false;
    const abort = () => database.interrupt();
    signal?.addEventListener('abort', abort, { once: true });
    database.each(sql, params, (error, row: Record<string, unknown>) => {
      if (error) {
        signal?.removeEventListener('abort', abort);
        reject(error);
        return;
      }
      if (truncated) return;
      columns = Object.keys(row).map((name) => ({ name, typeHint: null }));
      builder ??= new BoundedPageBuilder(columns, limit);
      if (!builder.push(Object.values(row))) truncated = true;
    }, (error) => {
      signal?.removeEventListener('abort', abort);
      if (error) { reject(error); return; }
      resolve({ ok: true, value: (builder ?? new BoundedPageBuilder(columns, limit)).finish() });
    });
  });
}



