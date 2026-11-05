import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import Cursor from 'pg-cursor';
import type { DatabaseProfile, SecretBundle } from '@shared/profiles';
import type { Result } from '@shared/contracts';
import { capture, ConnectorError, normalizeConnectorError, ok } from '../connector-errors.js';
import type { DatabaseAdapter, DatabaseSession, SqlSession, SqlTableOperations, SqlTableChangePlan } from '../contracts.js';
import { optionalDatabase, password, requiredHost, requiredPort, requiredUsername, tlsEnabled } from '../relational/connection-options.js';
import { BoundedPageBuilder } from '../relational/row-normalizer.js';
import type { ColumnDescriptor, ColumnTypeOption, TableIdentifier, TableDefinition, TableChange, NewTableColumn, WireValue, TablePage, RowInsert, RowUpdate, RowDelete } from '@shared/database';
import { MAX_METADATA_ITEMS } from '../contracts.js';

const capabilities = { namespaces: true, objects: true, queryMode: 'sql' as const, readRows: true, exportRows: true };
export class PostgresAdapter implements DatabaseAdapter {
  readonly engine = 'postgres' as const;
  async connect(profile: DatabaseProfile, secrets: SecretBundle): Promise<Result<DatabaseSession>> {
    try {
          const pool = new Pool({ host: requiredHost(profile), port: requiredPort(profile, 5432), user: requiredUsername(profile), password: password(secrets), database: optionalDatabase(profile) ?? 'postgres', ssl: tlsEnabled(profile) ? { rejectUnauthorized: true } : false, connectionTimeoutMillis: 10_000, statement_timeout: 30_000, application_name: 'Aetherexa' });
      const client = await pool.connect(); client.release();
      const session: SqlSession = {
        kind: 'sql', engine: this.engine, capabilities, tables: tableOperations(pool),
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

const columnTypes: ColumnTypeOption[] = [
  ...['smallint', 'integer', 'bigint', 'real', 'double precision', 'boolean', 'text', 'bytea', 'date', 'uuid', 'json', 'jsonb'].map((name) => ({ name, label: name, argumentCount: 0, minArgument: 0, maxArgument: 0 })),
  ...['varchar', 'char'].map((name) => ({ name, label: name, argumentCount: 1, minArgument: 1, maxArgument: 10_485_760 })),
  { name: 'numeric', label: 'numeric', argumentCount: 2, minArgument: 0, maxArgument: 1000 },
  ...['time', 'timestamp', 'timestamptz'].map((name) => ({ name, label: name, argumentCount: 1, minArgument: 0, maxArgument: 6 })),
];
type Scalar = null | boolean | number | string | Uint8Array;
type Transaction = { client: PoolClient; dispatched: boolean };
type Metadata = { definition: TableDefinition | null; fingerprint: string };

function invalid(message: string): never { throw new ConnectorError('invalid-input', message); }
function quoteIdentifier(name: string): string {
  if (!name || name.includes('\0') || Buffer.byteLength(name, 'utf8') > 63) invalid('PostgreSQL identifiers must contain 1 through 63 UTF-8 bytes and no NUL.');
  return '"' + name.replace(/"/g, '""') + '"';
}
function tableName(table: TableIdentifier): string { return quoteIdentifier(table.namespace) + '.' + quoteIdentifier(table.name); }
function scalarValue(value: WireValue): Scalar {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= 1_048_576) return value;
  if (value instanceof Uint8Array && value.byteLength <= 1_048_576) return Buffer.from(value);
  return invalid('This value is not supported for PostgreSQL table editing.');
}
function literal(value: WireValue): string {
  const scalar = scalarValue(value);
  if (scalar === null) return 'NULL';
  if (typeof scalar === 'boolean') return scalar ? 'TRUE' : 'FALSE';
  if (typeof scalar === 'number') return String(scalar);
  if (scalar instanceof Uint8Array) return "E'\\\\x" + Buffer.from(scalar).toString('hex') + "'::bytea";
  return "E'" + scalar.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
}
function unknownCompletion(error: unknown): boolean {
  if (error instanceof ConnectorError) return false;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  return !/^[0-9A-Z]{5}$/.test(code) || /^(08|57P0[123]$|40003$|EPIPE$)/.test(code);
}
async function transaction<T>(pool: Pool, operation: (tx: Transaction) => Promise<T>): Promise<Result<T>> {
  let client: PoolClient | undefined;
  let active = false;
  let discard = false;
  let dispatched = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    active = true;
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const context: Transaction = { client, dispatched: false };
    try {
      const result = await operation(context);
      dispatched = context.dispatched;
      await client.query('COMMIT');
      active = false;
      return ok(result);
    } finally { dispatched = context.dispatched; }
  } catch (error) {
    discard = unknownCompletion(error);
    if (active && client) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
    }
    if (dispatched && unknownCompletion(error)) return { ok: false, error: { code: 'completion-unknown', message: 'The connection failed after dispatch. Check the server before repeating this change.', retryable: false } };
    return { ok: false, error: normalizeConnectorError(error) };
  } finally { client?.release(discard); }
}
async function lockTable(client: PoolClient, table: TableIdentifier, mode: 'ACCESS SHARE' | 'ROW EXCLUSIVE' | 'ACCESS EXCLUSIVE'): Promise<void> {
  await client.query('LOCK TABLE ' + tableName(table) + ' IN ' + mode + ' MODE');
}
async function metadata(client: PoolClient, table: TableIdentifier): Promise<Metadata> {
  tableName(table);
  const relation = await client.query<{ schema_id: string; relation_id: string | null; relkind: string | null }>(
    'SELECT n.oid::text AS schema_id, c.oid::text AS relation_id, c.relkind FROM pg_catalog.pg_namespace n LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = $2 WHERE n.nspname = $1', [table.namespace, table.name]);
  const target = relation.rows[0];
  if (!target) throw new ConnectorError('table-not-found', 'The selected schema is unavailable.');
  if (target.relation_id === null) return { definition: null, fingerprint: createHash('sha256').update(JSON.stringify(target)).digest('hex') };
  if (target.relkind !== 'r' && target.relkind !== 'p') throw new ConnectorError('unsupported-feature', 'Table tools support ordinary and partitioned PostgreSQL tables.');
  const result = await client.query<{ column_name: string; type_name: string; is_nullable: string; column_default: string | null; primary_key_order: number | null; details: unknown }>(`
    SELECT c.column_name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type_name,
      c.is_nullable, c.column_default, pk.ordinal_position::int AS primary_key_order, row_to_json(c) AS details
    FROM information_schema.columns c
    JOIN pg_catalog.pg_attribute a ON a.attrelid = $3::oid AND a.attname = c.column_name AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN (
      SELECT kcu.column_name, kcu.ordinal_position
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_catalog = tc.constraint_catalog
        AND kcu.constraint_schema = tc.constraint_schema AND kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name
      WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2
    ) pk ON pk.column_name = c.column_name
    WHERE c.table_schema = $1 AND c.table_name = $2
    ORDER BY c.ordinal_position LIMIT $4`, [table.namespace, table.name, target.relation_id, MAX_METADATA_ITEMS + 1]);
  if (result.rows.length > MAX_METADATA_ITEMS) throw new ConnectorError('metadata-limit', 'The table metadata exceeds the supported size.');
  const bounded = new BoundedPageBuilder([], MAX_METADATA_ITEMS);
  for (const row of result.rows) {
    if (!bounded.push([row.column_name, row.type_name, row.is_nullable, row.column_default, row.primary_key_order])) throw new ConnectorError('metadata-limit', 'The table metadata exceeds a cell or page size limit.');
  }
  const visible = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM pg_catalog.pg_attribute WHERE attrelid = $1::oid AND attnum > 0 AND NOT attisdropped', [target.relation_id]);
  if (visible.rows[0]?.count !== result.rows.length) throw new ConnectorError('unsupported-feature', 'Complete table metadata is required for table tools.');
  const definition: TableDefinition = { table: { ...table }, columns: result.rows.map((row) => ({ name: row.column_name, typeName: row.type_name, nullable: row.is_nullable === 'YES', defaultExpression: row.column_default, primaryKeyOrder: row.primary_key_order })) };
  return { definition, fingerprint: createHash('sha256').update(JSON.stringify({ target, columns: result.rows })).digest('hex') };
}
function requireDefinition(info: Metadata): TableDefinition {
  if (!info.definition) throw new ConnectorError('table-not-found', 'The selected table is unavailable.');
  return info.definition;
}
function column(definition: TableDefinition, name: string) {
  const found = definition.columns.find((item) => item.name === name);
  if (!found) return invalid('A selected column is no longer available.');
  return found;
}
function primaryKey(definition: TableDefinition): string[] {
  const keys = definition.columns.filter((item) => item.primaryKeyOrder !== null).sort((a, b) => (a.primaryKeyOrder ?? 0) - (b.primaryKeyOrder ?? 0)).map((item) => item.name);
  if (!keys.length) throw new ConnectorError('read-only-table', 'Row editing requires a declared primary key.');
  return keys;
}
function columnSql(input: NewTableColumn): string {
  const option = columnTypes.find((item) => item.name === input.type.name);
  if (!option || input.type.arguments.length !== option.argumentCount || input.type.arguments.some((value) => !Number.isInteger(value) || value < option.minArgument || value > option.maxArgument)) invalid('Select a supported PostgreSQL type and valid arguments.');
  if (input.type.name === 'numeric' && (input.type.arguments[0] < 1 || input.type.arguments[1] > input.type.arguments[0])) invalid('Numeric scale must be between zero and its positive precision.');
  const type = input.type.name + (input.type.arguments.length ? '(' + input.type.arguments.join(', ') + ')' : '');
  const defaultSql = input.default.kind === 'none' ? '' : input.default.kind === 'current-timestamp' ? ' DEFAULT CURRENT_TIMESTAMP' : ' DEFAULT ' + literal(input.default.value);
  return quoteIdentifier(input.name) + ' ' + type + (input.nullable ? '' : ' NOT NULL') + defaultSql;
}
function changeStatement(change: TableChange, definition: TableDefinition | null): string {
  const name = tableName(change.table);
  if (change.kind === 'create') {
    if (definition) throw new ConnectorError('table-exists', 'A relation already exists with this name.');
    if (!change.columns.length || change.columns.length > 256 || change.primaryKey.length > 256) invalid('Select between 1 and 256 table columns.');
    const names = new Set(change.columns.map((item) => item.name));
    if (names.size !== change.columns.length || new Set(change.primaryKey).size !== change.primaryKey.length || change.primaryKey.some((key) => !names.has(key))) invalid('Column names must be unique and primary-key columns must exist.');
    const columns = change.columns.map(columnSql);
    if (change.primaryKey.length) columns.push('PRIMARY KEY (' + change.primaryKey.map(quoteIdentifier).join(', ') + ')');
    return 'CREATE TABLE ' + name + ' (' + columns.join(', ') + ')';
  }
  if (!definition) throw new ConnectorError('table-not-found', 'The selected table is unavailable.');
  if (change.kind === 'add-column') {
    if (definition.columns.some((item) => item.name === change.column.name)) invalid('A column already exists with this name.');
    return 'ALTER TABLE ' + name + ' ADD COLUMN ' + columnSql(change.column);
  }
  if (change.kind === 'rename-column') {
    column(definition, change.from);
    if (definition.columns.some((item) => item.name === change.to)) invalid('A column already exists with this name.');
    return 'ALTER TABLE ' + name + ' RENAME COLUMN ' + quoteIdentifier(change.from) + ' TO ' + quoteIdentifier(change.to);
  }
  column(definition, change.column);
  return 'ALTER TABLE ' + name + ' DROP COLUMN ' + quoteIdentifier(change.column);
}
function tableOperations(pool: Pool): SqlTableOperations {
  return {
    describeTable(table) { return transaction(pool, async ({ client }) => {
      await lockTable(client, table, 'ACCESS SHARE');
      return requireDefinition(await metadata(client, table));
    }); },
    async listColumnTypes() { return ok(columnTypes.map((item) => ({ ...item }))); },
    readTablePage(request) { return transaction<TablePage>(pool, async ({ client }) => {
      if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 200 || !Number.isInteger(request.offset) || request.offset < 0 || request.offset > 2_147_483_647 || request.filters.length > 10) invalid('The page request exceeds the supported bounds.');
      await lockTable(client, request.table, 'ACCESS SHARE');
      const definition = requireDefinition(await metadata(client, request.table));
      const values: Scalar[] = [];
      const bind = (value: WireValue) => { values.push(scalarValue(value)); return '$' + values.length; };
      const filters = request.filters.map((filter) => {
        const descriptor = column(definition, filter.column);
        const name = quoteIdentifier(filter.column);
        if (filter.operator === 'is-null') return name + ' IS NULL';
        if (filter.operator === 'is-not-null') return name + ' IS NOT NULL';
        if (filter.operator === 'equals') {
          if (filter.value === null) invalid('Use a null filter for null values.');
          if (typeof filter.value === 'string' && Buffer.byteLength(filter.value, 'utf8') > 4096) invalid('Filter text exceeds 4 KiB.');
          return name + ' = ' + bind(filter.value);
        }
        if (typeof filter.value !== 'string' || Buffer.byteLength(filter.value, 'utf8') > 4096) invalid('Contains requires text of at most 4 KiB.');
        if (!/^(text|character varying|character)(\(|$)/.test(descriptor.typeName)) throw new ConnectorError('unsupported-feature', 'Contains is supported only for text columns.');
        return name + ' LIKE ' + bind('%' + filter.value.replace(/[!%_]/g, '!$&') + '%') + " ESCAPE '!'";
      });
      const order: string[] = [];
      if (request.sort) {
        column(definition, request.sort.column);
        if (request.sort.direction !== 'asc' && request.sort.direction !== 'desc') invalid('Select a supported sort direction.');
        order.push(quoteIdentifier(request.sort.column) + ' ' + request.sort.direction.toUpperCase());
      }
      const keys = definition.columns.filter((item) => item.primaryKeyOrder !== null).sort((a, b) => (a.primaryKeyOrder ?? 0) - (b.primaryKeyOrder ?? 0)).map((item) => item.name);
      for (const key of keys) if (request.sort?.column !== key) order.push(quoteIdentifier(key) + ' ASC');
      order.push('tableoid ASC', 'ctid ASC');
      const sql = 'SELECT ' + definition.columns.map((item) => quoteIdentifier(item.name)).join(', ') + ' FROM ' + tableName(request.table) + (filters.length ? ' WHERE ' + filters.join(' AND ') : '') + ' ORDER BY ' + order.join(', ') + ' LIMIT ' + bind(request.limit + 1) + ' OFFSET ' + bind(request.offset);
      let cursor: Cursor<unknown[]> | undefined;
      try {
        cursor = client.query(new Cursor(sql, values, { rowMode: 'array' }));
        const builder = new BoundedPageBuilder(definition.columns.map((item) => ({ name: item.name, typeHint: item.typeName })), request.limit);
        let count = 0;
        let hasNext = false;
        while (true) {
          const batch = await readCursor(cursor, Math.min(32, request.limit + 1 - count));
          if (!batch.rows.length) break;
          for (const row of batch.rows) {
            if (count === request.limit) { hasNext = true; break; }
            if (!builder.push(row)) throw new ConnectorError('table-page-limit', 'The complete table page exceeds a cell or page size limit. Request fewer rows.');
            count++;
          }
          if (hasNext) break;
        }
        return { definition, rows: builder.finish().rows, offset: request.offset, limit: request.limit, hasNext };
      } finally { await cursor?.close(); }
    }); },
    planTableChange(change) { return transaction<SqlTableChangePlan>(pool, async ({ client }) => {
      if (change.kind !== 'create') await lockTable(client, change.table, 'ACCESS SHARE');
      const info = await metadata(client, change.table);
      const statement = changeStatement(change, info.definition);
      return { change: structuredClone(change), statements: [statement], destructive: change.kind === 'rename-column' || change.kind === 'drop-column', schemaFingerprint: info.fingerprint };
    }); },
    applyTableChange(plan) { return transaction<void>(pool, async (tx) => {
      if (plan.change.kind !== 'create') await lockTable(tx.client, plan.change.table, 'ACCESS EXCLUSIVE');
      const info = await metadata(tx.client, plan.change.table);
      if (info.fingerprint !== plan.schemaFingerprint) throw new ConnectorError('stale-table-plan', 'The table schema changed. Preview the change again.');
      const statement = changeStatement(plan.change, info.definition);
      if (plan.statements.length !== 1 || plan.statements[0] !== statement) throw new ConnectorError('invalid-table-plan', 'Preview the table change again before applying it.');
      tx.dispatched = true;
      await tx.client.query(statement);
    }); },
    insertRow(input) { return mutateRow(pool, { kind: 'insert', input }); },
    updateRow(input) { return mutateRow(pool, { kind: 'update', input }); },
    deleteRow(input) { return mutateRow(pool, { kind: 'delete', input }); },
  };
}
function mutateRow(pool: Pool, request: { kind: 'insert'; input: RowInsert } | { kind: 'update'; input: RowUpdate } | { kind: 'delete'; input: RowDelete }): Promise<Result<{ affectedRows: number }>> {
  return transaction(pool, async (tx) => {
    const table = request.input.table;
    await lockTable(tx.client, table, 'ROW EXCLUSIVE');
    const definition = requireDefinition(await metadata(tx.client, table));
    const keys = primaryKey(definition);
    const values: Scalar[] = [];
    const bind = (value: WireValue) => { values.push(scalarValue(value)); return '$' + values.length; };
    const entries = (input: Record<string, WireValue>) => {
      const result = Object.entries(input);
      if (result.length > 256) invalid('A row request supports at most 256 columns.');
      for (const [name, value] of result) { column(definition, name); scalarValue(value); }
      return result;
    };
    let sql: string;
    if (request.kind === 'insert') {
      const columns = entries(request.input.values);
      sql = 'INSERT INTO ' + tableName(table) + (columns.length ? ' (' + columns.map(([name]) => quoteIdentifier(name)).join(', ') + ') VALUES (' + columns.map(([, value]) => bind(value)).join(', ') + ')' : ' DEFAULT VALUES');
    } else {
      const input = request.input;
      const suppliedKey = entries(input.key);
      if (suppliedKey.length !== keys.length || keys.some((key) => !Object.hasOwn(input.key, key)) || suppliedKey.some(([, value]) => value === null)) invalid('Row changes require the exact full primary key.');
      const predicates = keys.map((key) => quoteIdentifier(key) + ' IS NOT DISTINCT FROM ' + bind(input.key[key]));
      if (request.kind === 'update') {
        const update = request.input;
        const updated = entries(update.values);
        const expected = entries(update.expectedValues);
        if (!updated.length || updated.length !== expected.length || updated.some(([name]) => !Object.hasOwn(update.expectedValues, name))) invalid('Each edited column requires its original value.');
        for (const [name, value] of expected) predicates.push(quoteIdentifier(name) + ' IS NOT DISTINCT FROM ' + bind(value));
        sql = 'UPDATE ' + tableName(table) + ' SET ' + updated.map(([name, value]) => quoteIdentifier(name) + ' = ' + bind(value)).join(', ') + ' WHERE ' + predicates.join(' AND ');
      } else {
        sql = 'DELETE FROM ' + tableName(table) + ' WHERE ' + predicates.join(' AND ');
      }
    }
    tx.dispatched = true;
    const result = await tx.client.query(sql, values);
    if (result.rowCount !== 1) throw new ConnectorError(result.rowCount === 0 ? 'stale-row' : 'unexpected-row-count', result.rowCount === 0 ? 'The row no longer matches. Reload the table before editing it again.' : 'The change did not affect exactly one row and was rolled back.');
    return { affectedRows: 1 };
  });
}
