import mysql from 'mysql2';
import { createHash } from 'node:crypto';
import type { Pool, PoolConnection, FieldPacket, RowDataPacket, ResultSetHeader } from 'mysql2';
import type { PoolConnection as PromiseConnection } from 'mysql2/promise';
import type { DatabaseProfile, SecretBundle } from '@shared/profiles';
import type { Result } from '@shared/contracts';
import { ConnectorError, capture, ok, normalizeConnectorError } from '../connector-errors.js';
import type { DatabaseAdapter, DatabaseSession, SqlSession, SqlTableOperations, SqlTableChangePlan } from '../contracts.js';
import { optionalDatabase, password, requiredHost, requiredPort, requiredUsername, tlsEnabled } from '../relational/connection-options.js';
import { BoundedPageBuilder } from '../relational/row-normalizer.js';
import type { ColumnDescriptor, ColumnTypeOption, NewTableColumn, TableChange, TableDefinition, TableIdentifier, TablePage, TablePageRequest, WireValue } from '@shared/database';

const capabilities = { namespaces: true, objects: true, queryMode: 'sql' as const, readRows: true, exportRows: true };
export class MysqlAdapter implements DatabaseAdapter {
  readonly engine = 'mysql' as const;
  async connect(profile: DatabaseProfile, secrets: SecretBundle): Promise<Result<DatabaseSession>> {
    try {
      const pool = mysql.createPool({ host: requiredHost(profile), port: requiredPort(profile, 3306), user: requiredUsername(profile), password: password(secrets), database: optionalDatabase(profile), ssl: tlsEnabled(profile) ? { rejectUnauthorized: true } : undefined, waitForConnections: true, connectionLimit: 2, connectTimeout: 10_000, supportBigNumbers: true, bigNumberStrings: true, flags: ['FOUND_ROWS'] });
      await new Promise<void>((resolve, reject) => pool.getConnection((error, connection) => { if (error) reject(error); else { connection.release(); resolve(); } }));
      const session: SqlSession = {
        kind: 'sql', engine: this.engine, capabilities,
        tables: createTableOperations(pool),
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

type Scalar = null | string | number | boolean;
type MysqlColumn = RowDataPacket & {
  name: string;
  typeName: string;
  dataType: string;
  nullable: string;
  defaultValue: string | null;
  extra: string;
  generation: string;
  collation: string | null;
  numericScale: number | null;
  primaryKeyOrder: number | null;
};
type MysqlTable = {
  definition: TableDefinition;
  columns: Map<string, MysqlColumn>;
  primaryKey: MysqlColumn[];
  fingerprint: string;
};
type SqlContext = RowDataPacket & { version: string; sqlMode: string; charset: string; collation: string };
type MysqlType = ColumnTypeOption & { category: 'number' | 'text' | 'temporal'; defaults: boolean };
const columnTypes: readonly MysqlType[] = [
  { name: 'INT', label: 'Integer', argumentCount: 0, minArgument: 0, maxArgument: 0, category: 'number', defaults: true },
  { name: 'BIGINT', label: 'Big integer', argumentCount: 0, minArgument: 0, maxArgument: 0, category: 'number', defaults: true },
  { name: 'DECIMAL', label: 'Decimal (precision, scale)', argumentCount: 2, minArgument: 0, maxArgument: 65, category: 'number', defaults: true },
  { name: 'DOUBLE', label: 'Double precision', argumentCount: 0, minArgument: 0, maxArgument: 0, category: 'number', defaults: true },
  { name: 'VARCHAR', label: 'Variable text (length)', argumentCount: 1, minArgument: 1, maxArgument: 16383, category: 'text', defaults: true },
  { name: 'CHAR', label: 'Fixed text (length)', argumentCount: 1, minArgument: 1, maxArgument: 255, category: 'text', defaults: true },
  { name: 'TEXT', label: 'Text', argumentCount: 0, minArgument: 0, maxArgument: 0, category: 'text', defaults: false },
  { name: 'DATE', label: 'Date', argumentCount: 0, minArgument: 0, maxArgument: 0, category: 'temporal', defaults: true },
  { name: 'DATETIME', label: 'Date and time', argumentCount: 0, minArgument: 0, maxArgument: 0, category: 'temporal', defaults: true },
  { name: 'TIMESTAMP', label: 'Timestamp', argumentCount: 0, minArgument: 0, maxArgument: 0, category: 'temporal', defaults: true },
];
const textTypes = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set']);
const numericTypes = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric', 'float', 'double', 'real', 'year']);
const exactNumericTypes = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric', 'year']);
const temporalTypes = new Set(['date', 'datetime', 'timestamp', 'time']);

function createTableOperations(pool: Pool): SqlTableOperations {
  async function useConnection<T>(operation: (connection: PromiseConnection, raw: PoolConnection) => Promise<T>): Promise<Result<T>> {
    return capture(async () => {
      const connection = await new Promise<PoolConnection>((resolve, reject) => pool.getConnection((error, value) => error ? reject(error) : resolve(value)));
      try { return await operation(connection.promise(), connection); }
      finally { connection.release(); }
    });
  }
  return {
    describeTable: (table) => useConnection(async (connection) => (await requireTable(connection, table)).definition),
    listColumnTypes: async () => ok(columnTypes.map(({ name, label, argumentCount, minArgument, maxArgument }) => ({ name, label, argumentCount, minArgument, maxArgument }))),
    readTablePage: (request) => useConnection((connection, raw) => readTablePage(connection, raw, request)),
    planTableChange: (change) => useConnection((connection) => planTableChange(connection, change)),
    applyTableChange: (plan) => useConnection(async (connection) => {
      const current = await planTableChange(connection, plan.change);
      if (current.schemaFingerprint !== plan.schemaFingerprint ||
          current.destructive !== plan.destructive || JSON.stringify(current.statements) !== JSON.stringify(plan.statements)) {
        throw new ConnectorError('schema-changed', 'The table or connection settings changed. Preview the change again.');
      }
      await executeMutation(connection, plan.statements[0], []);
    }),
    insertRow: (input) => useConnection(async (connection) => {
      const table = await requireTable(connection, input.table);
      requirePrimaryKey(table);
      const entries = Object.entries(input.values);
      const values = entries.map(([name, value]) => writableValue(requireColumn(table, name), value));
      const columns = entries.map(([name]) => quoteIdentifier(name)).join(', ');
      const parameters = values.map(() => '?').join(', ');
      await requireStrictMode(connection);
      const result = await executeMutation(connection, `INSERT INTO ${tableReference(table.definition.table)} (${columns}) VALUES (${parameters})`, values);
      return { affectedRows: result.affectedRows };
    }),
    updateRow: (input) => useConnection(async (connection) => {
      const table = await requireTable(connection, input.table);
      const key = keyPredicate(table, input.key);
      const names = Object.keys(input.values);
      if (!names.length || names.length !== Object.keys(input.expectedValues).length ||
          names.some((name) => !Object.hasOwn(input.expectedValues, name))) {
        throw new ConnectorError('invalid-input', 'Include an original value for every edited column.');
      }
      const values = names.map((name) => writableValue(requireColumn(table, name), input.values[name]));
      const expected = names.map((name) => columnValue(requireColumn(table, name), input.expectedValues[name]));
      const predicates = names.map((name, index) => typeof expected[index] === 'string' && textTypes.has(requireColumn(table, name).dataType)
        ? `CAST(CONVERT(${quoteIdentifier(name)} USING utf8mb4) AS BINARY) <=> CAST(CONVERT(? USING utf8mb4) AS BINARY)`
        : `${quoteIdentifier(name)} <=> ${comparisonParameter(requireColumn(table, name))}`);
      await requireStrictMode(connection);
      const result = await executeMutation(connection,
        `UPDATE ${tableReference(table.definition.table)} SET ${names.map((name) => `${quoteIdentifier(name)} = ?`).join(', ')} WHERE ${key.sql} AND ${predicates.join(' AND ')}`,
        [...values, ...key.values, ...expected]);
      if (result.affectedRows === 0) throw new ConnectorError('stale-row', 'The row changed or was deleted. Reload the table before editing again.');
      if (result.affectedRows !== 1) throw new ConnectorError('completion-unknown', 'The update result could not be confirmed. Reload the table before another write.');
      return { affectedRows: result.affectedRows };
    }),
    deleteRow: (input) => useConnection(async (connection) => {
      const table = await requireTable(connection, input.table);
      const key = keyPredicate(table, input.key);
      const result = await executeMutation(connection, `DELETE FROM ${tableReference(table.definition.table)} WHERE ${key.sql}`, key.values);
      if (result.affectedRows === 0) throw new ConnectorError('stale-row', 'The row was already deleted. Reload the table.');
      if (result.affectedRows !== 1) throw new ConnectorError('completion-unknown', 'The delete result could not be confirmed. Reload the table before another write.');
      return { affectedRows: result.affectedRows };
    }),
  };
}

async function lookupTable(connection: PromiseConnection, requested: TableIdentifier): Promise<MysqlTable | null> {
  validateIdentifier(requested.namespace);
  validateIdentifier(requested.name);
  const [tables] = await connection.execute<RowDataPacket[]>(
    'SELECT TABLE_SCHEMA AS namespace, TABLE_NAME AS name, TABLE_TYPE AS kind, ENGINE AS engine, TABLE_COLLATION AS collation FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [requested.namespace, requested.name]);
  if (!tables.length) return null;
  if (tables.length !== 1 || tables[0].kind !== 'BASE TABLE') throw new ConnectorError('unsupported-feature', 'Choose a base table for table tools.');
  const table = { namespace: String(tables[0].namespace), name: String(tables[0].name) };
  const [columns] = await connection.execute<MysqlColumn[]>(
    `SELECT c.COLUMN_NAME AS name, c.COLUMN_TYPE AS typeName, c.DATA_TYPE AS dataType,
      c.IS_NULLABLE AS nullable, c.COLUMN_DEFAULT AS defaultValue, c.EXTRA AS extra,
      c.GENERATION_EXPRESSION AS generation, c.COLLATION_NAME AS collation, c.NUMERIC_SCALE AS numericScale,
      k.ORDINAL_POSITION AS primaryKeyOrder
     FROM INFORMATION_SCHEMA.COLUMNS c
     LEFT JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
       ON k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME
       AND k.COLUMN_NAME = c.COLUMN_NAME AND k.CONSTRAINT_NAME = 'PRIMARY'
     WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ? ORDER BY c.ORDINAL_POSITION`, [table.namespace, table.name]);
  if (!columns.length || columns.length > 10000) throw new ConnectorError('unsupported-feature', 'The table metadata cannot be represented safely.');
  const definition: TableDefinition = {
    table,
    columns: columns.map((column) => ({ name: column.name, typeName: column.typeName, nullable: column.nullable === 'YES',
      defaultExpression: column.defaultValue === null ? null : String(column.defaultValue),
      primaryKeyOrder: column.primaryKeyOrder === null ? null : Number(column.primaryKeyOrder) })),
  };
  return {
    definition,
    columns: new Map(columns.map((column) => [column.name, column])),
    primaryKey: columns.filter((column) => column.primaryKeyOrder !== null).sort((a, b) => Number(a.primaryKeyOrder) - Number(b.primaryKeyOrder)),
    fingerprint: digest({ table: tables[0], columns }),
  };
}

async function requireTable(connection: PromiseConnection, table: TableIdentifier): Promise<MysqlTable> {
  const metadata = await lookupTable(connection, table);
  if (!metadata) throw new ConnectorError('table-not-found', 'The table no longer exists or is not accessible.');
  return metadata;
}

function requireColumn(table: MysqlTable, name: string): MysqlColumn {
  const column = table.columns.get(name);
  if (!column) throw new ConnectorError('invalid-input', 'Choose a column from the current table definition.');
  return column;
}

function requirePrimaryKey(table: MysqlTable): void {
  if (!table.primaryKey.length) throw new ConnectorError('unsupported-feature', 'Row writes require a declared primary key.');
}

function keyPredicate(table: MysqlTable, key: Record<string, WireValue>): { sql: string; values: Scalar[] } {
  requirePrimaryKey(table);
  if (Object.keys(key).length !== table.primaryKey.length || table.primaryKey.some((column) => !Object.hasOwn(key, column.name))) {
    throw new ConnectorError('invalid-input', 'Provide every primary-key column and no other key fields.');
  }
  const values = table.primaryKey.map((column) => {
    if (key[column.name] === null) throw new ConnectorError('unsupported-feature', 'A null primary-key value cannot identify an editable row.');
    return columnValue(column, key[column.name]);
  });
  return { sql: table.primaryKey.map((column) => `${quoteIdentifier(column.name)} = ${comparisonParameter(column)}`).join(' AND '), values };
}

function scalar(value: WireValue): Scalar {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  throw new ConnectorError('unsupported-feature', 'Use a supported scalar value; large integers must be entered as text.');
}

function columnValue(column: MysqlColumn, input: WireValue): Scalar {
  const value = scalar(input);
  if (value === null) return value;
  if (textTypes.has(column.dataType) || temporalTypes.has(column.dataType)) {
    if (typeof value !== 'string') throw new ConnectorError('invalid-input', 'Text and date columns require text values.');
    return value;
  }
  if (numericTypes.has(column.dataType)) {
    if (exactNumericTypes.has(column.dataType)) {
      const text = String(typeof value === 'boolean' ? Number(value) : value);
      const match = /^[+-]?(\d+)(?:\.(\d+))?$/.exec(text);
      const scale = Number(column.numericScale ?? 0);
      if (!match || (match[2]?.length ?? 0) > scale || match[1].replace(/^0+/, '').length > 65 - scale) {
        throw new ConnectorError('invalid-input', 'Use an exact numeric value within this column\'s decimal scale, without exponent notation.');
      }
      return value;
    }
    if (typeof value !== 'number' && typeof value !== 'boolean') {
      throw new ConnectorError('invalid-input', 'Enter a numeric value for this column.');
    }
    return value;
  }
  throw new ConnectorError('unsupported-feature', 'This column type is available for browsing only.');
}

function comparisonParameter(column: MysqlColumn): string {
  return exactNumericTypes.has(column.dataType) ? `CAST(? AS DECIMAL(65, ${Number(column.numericScale ?? 0)}))` : '?';
}

function writableValue(column: MysqlColumn, input: WireValue): Scalar {
  if (column.generation || /(?:VIRTUAL|STORED) GENERATED/i.test(column.extra)) throw new ConnectorError('unsupported-feature', 'Generated columns cannot be assigned.');
  const value = columnValue(column, input);
  if (value === null && column.nullable !== 'YES') throw new ConnectorError('invalid-input', 'This column does not allow null.');
  return value;
}

async function readTablePage(connection: PromiseConnection, raw: PoolConnection, request: TablePageRequest): Promise<TablePage> {
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 200 ||
      !Number.isInteger(request.offset) || request.offset < 0 || request.offset > 2147483647 || request.filters.length > 10) {
    throw new ConnectorError('invalid-input', 'Choose a page of 1 to 200 rows, a valid offset, and at most 10 filters.');
  }
  const table = await requireTable(connection, request.table);
  const values: Scalar[] = [];
  const predicates = request.filters.map((filter) => {
    const column = requireColumn(table, filter.column);
    const name = quoteIdentifier(column.name);
    if (filter.operator === 'is-null') return `${name} IS NULL`;
    if (filter.operator === 'is-not-null') return `${name} IS NOT NULL`;
    if (typeof filter.value === 'string' && Buffer.byteLength(filter.value, 'utf8') > 4096) throw new ConnectorError('invalid-input', 'Text filters must not exceed 4 KiB.');
    if (filter.operator === 'contains') {
      if (typeof filter.value !== 'string' || !textTypes.has(column.dataType)) throw new ConnectorError('invalid-input', 'Contains filters require a text column and text value.');
      values.push('%' + filter.value.replace(/[!%_]/g, '!$&') + '%');
      return `${name} LIKE ? ESCAPE '!'`;
    }
    if (filter.operator !== 'equals' || filter.value === null) throw new ConnectorError('invalid-input', 'Use a supported filter and a non-null equality value.');
    values.push(columnValue(column, filter.value));
    return `${name} = ${comparisonParameter(column)}`;
  });
  const order: string[] = [];
  if (request.sort) {
    const column = requireColumn(table, request.sort.column);
    if (request.sort.direction !== 'asc' && request.sort.direction !== 'desc') throw new ConnectorError('invalid-input', 'Choose ascending or descending order.');
    order.push(`${quoteIdentifier(column.name)} ${request.sort.direction === 'asc' ? 'ASC' : 'DESC'}`);
  }
  for (const column of table.primaryKey) if (column.name !== request.sort?.column) order.push(`${quoteIdentifier(column.name)} ASC`);
  const names = table.definition.columns.map((column) => quoteIdentifier(column.name)).join(', ');
  const statement = `SELECT ${names} FROM ${tableReference(table.definition.table)}` +
    (predicates.length ? ` WHERE ${predicates.join(' AND ')}` : '') +
    (order.length ? ` ORDER BY ${order.join(', ')}` : '') + ' LIMIT ? OFFSET ?';
  const stream = raw.execute({ sql: statement, rowsAsArray: true, dateStrings: true }, [...values, request.limit + 1, request.offset]).stream({ highWaterMark: 1 });
  const builder = new BoundedPageBuilder(table.definition.columns.map((column) => ({ name: column.name, typeHint: column.typeName })), request.limit);
  let count = 0;
  let limited = false;
  for await (const row of stream) {
    count += 1;
    if (!limited && count <= request.limit && !builder.push(row as unknown[])) limited = true;
  }
  if (limited) throw new ConnectorError('result-limit', 'This page exceeds the cell or page byte limit. Reduce the page size or use a SQL query selecting fewer columns.');
  return { definition: table.definition, rows: builder.finish().rows, offset: request.offset, limit: request.limit, hasNext: count > request.limit };
}

async function sqlContext(connection: PromiseConnection): Promise<SqlContext> {
  const [rows] = await connection.query<SqlContext[]>('SELECT VERSION() AS version, @@SESSION.sql_mode AS sqlMode, @@SESSION.character_set_connection AS charset, @@SESSION.collation_connection AS collation');
  return rows[0];
}

async function requireStrictMode(connection: PromiseConnection): Promise<void> {
  if (!/(?:^|,)STRICT_(?:ALL|TRANS)_TABLES(?:,|$)/.test((await sqlContext(connection)).sqlMode)) {
    throw new ConnectorError('unsupported-feature', 'Row inserts and updates require strict SQL mode to prevent silent value conversion.');
  }
}

async function planTableChange(connection: PromiseConnection, change: TableChange): Promise<SqlTableChangePlan> {
  const context = await sqlContext(connection);
  const maria = /MariaDB/i.test(context.version);
  const versionPrefix = maria ? context.version.replace(/^5\.5\.5-/, '') : context.version;
  const version = /^(\d+)\.(\d+)\.(\d+)/.exec(versionPrefix)?.slice(1).map(Number);
  const versionNumber = version ? version[0] * 10000 + version[1] * 100 + version[2] : 0;
  if (versionNumber < (maria ? 100200 : 50700)) throw new ConnectorError('unsupported-feature', 'Table design requires MySQL 5.7 or MariaDB 10.2 or later.');
  const table = await lookupTable(connection, change.table);
  let statement: string;
  let schemaFingerprint: string;
  if (change.kind === 'create') {
    if (table) throw new ConnectorError('schema-changed', 'A table with this name already exists.');
    const [namespaces] = await connection.execute<RowDataPacket[]>('SELECT SCHEMA_NAME AS name, DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?', [change.table.namespace]);
    if (namespaces.length !== 1) throw new ConnectorError('invalid-input', 'Choose an accessible database namespace.');
    if (!change.columns.length || change.columns.length > 256) throw new ConnectorError('invalid-input', 'Create a table with 1 to 256 columns.');
    const names = change.columns.map((column) => column.name.toLowerCase());
    if (new Set(names).size !== names.length || new Set(change.primaryKey.map((name) => name.toLowerCase())).size !== change.primaryKey.length) throw new ConnectorError('invalid-input', 'Column and primary-key names must be unique.');
    for (const name of change.primaryKey) {
      const column = change.columns.find((candidate) => candidate.name === name);
      if (!column || column.nullable || column.type.name === 'TEXT') throw new ConnectorError('invalid-input', 'Primary-key columns must exist, be non-nullable, and use an indexable type.');
    }
    const columns = change.columns.map((column) => columnDefinition(column, context));
    if (change.primaryKey.length) columns.push(`PRIMARY KEY (${change.primaryKey.map(quoteIdentifier).join(', ')})`);
    statement = `CREATE TABLE ${tableReference(change.table)} (${columns.join(', ')})`;
    schemaFingerprint = digest({ absent: change.table, namespace: namespaces[0], context });
  } else {
    if (!table) throw new ConnectorError('schema-changed', 'The table no longer exists. Preview a new change.');
    const reference = tableReference(table.definition.table);
    if (change.kind === 'add-column') {
      requireNewColumn(table, change.column.name);
      statement = `ALTER TABLE ${reference} ADD COLUMN ${columnDefinition(change.column, context)}`;
    } else if (change.kind === 'rename-column') {
      if (versionNumber < (maria ? 100502 : 80000)) throw new ConnectorError('unsupported-feature', 'Column rename requires MySQL 8.0 or MariaDB 10.5.2 or later.');
      requireColumn(table, change.from);
      requireNewColumn(table, change.to);
      statement = `ALTER TABLE ${reference} RENAME COLUMN ${quoteIdentifier(change.from)} TO ${quoteIdentifier(change.to)}`;
    } else {
      requireColumn(table, change.column);
      if (table.primaryKey.some((column) => column.name === change.column)) throw new ConnectorError('unsupported-feature', 'The table designer cannot change an existing primary key.');
      statement = `ALTER TABLE ${reference} DROP COLUMN ${quoteIdentifier(change.column)}`;
    }
    schemaFingerprint = digest({ table: table.fingerprint, context });
  }
  return { change, statements: [statement], destructive: change.kind === 'rename-column' || change.kind === 'drop-column', schemaFingerprint };
}

function requireNewColumn(table: MysqlTable, name: string): void {
  validateIdentifier(name);
  if ([...table.columns.keys()].some((current) => current.toLowerCase() === name.toLowerCase())) throw new ConnectorError('invalid-input', 'A column with this name already exists.');
}

function columnDefinition(column: NewTableColumn, context: SqlContext): string {
  validateIdentifier(column.name);
  const type = columnTypes.find((candidate) => candidate.name === column.type.name);
  const args = column.type.arguments;
  if (!type || args.length !== type.argumentCount || args.some((value) => !Number.isInteger(value) || value < type.minArgument || value > type.maxArgument)) {
    throw new ConnectorError('invalid-input', 'Choose a supported column type and valid type arguments.');
  }
  if (type.name === 'DECIMAL' && (args[0] < 1 || args[1] > 30 || args[1] > args[0])) throw new ConnectorError('invalid-input', 'Decimal precision must be 1 to 65 and scale 0 to 30, no larger than precision.');
  let defaultSql = '';
  if (column.default.kind !== 'none') {
    if (!type.defaults) throw new ConnectorError('unsupported-feature', 'Defaults for this type are not supported by the table designer.');
    if (column.default.kind === 'current-timestamp') {
      if (type.name !== 'TIMESTAMP' && type.name !== 'DATETIME') throw new ConnectorError('invalid-input', 'CURRENT_TIMESTAMP requires a timestamp or datetime column.');
      defaultSql = ' DEFAULT CURRENT_TIMESTAMP';
    } else {
      const value = scalar(column.default.value);
      if (value === null && !column.nullable) throw new ConnectorError('invalid-input', 'A non-nullable column cannot default to null.');
      if (value !== null && type.category !== 'number' && typeof value !== 'string') throw new ConnectorError('invalid-input', 'Text and date defaults require text values.');
      if (type.category === 'number' && typeof value === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) throw new ConnectorError('invalid-input', 'Numeric defaults require numeric values.');
      defaultSql = ' DEFAULT ' + defaultLiteral(value, context.sqlMode);
    }
  }
  return `${quoteIdentifier(column.name)} ${type.name}${args.length ? '(' + args.join(', ') + ')' : ''}${column.nullable ? ' NULL' : ' NOT NULL'}${defaultSql}`;
}

function defaultLiteral(value: Scalar, sqlMode: string): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return String(value);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new ConnectorError('unsupported-feature', 'Control characters are not supported in column defaults.');
  const escaped = sqlMode.split(',').includes('NO_BACKSLASH_ESCAPES') ? value : value.replaceAll('\\', '\\\\');
  return "'" + escaped.replaceAll("'", "''") + "'";
}

function validateIdentifier(value: string): void {
  if (!value || [...value].length > 64 || /[\u0000-\u001f\u007f]/.test(value) || value.endsWith(' ')) throw new ConnectorError('invalid-input', 'Use a valid MySQL identifier of at most 64 characters.');
}

function quoteIdentifier(value: string): string { return '`' + value.replaceAll('`', '``') + '`'; }
function tableReference(table: TableIdentifier): string { return `${quoteIdentifier(table.namespace)}.${quoteIdentifier(table.name)}`; }
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

async function executeMutation(connection: PromiseConnection, statement: string, values: Scalar[]): Promise<ResultSetHeader> {
  try {
    const [result] = await connection.execute<ResultSetHeader>(statement, values);
    if (result.warningStatus) throw new ConnectorError('completion-unknown', 'The server completed the write with warnings. Reload the table before another write.');
    return result;
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    const serverError = error as { code?: string; errno?: number; sqlState?: string };
    if (!serverError.sqlState || !serverError.errno || /TIMEOUT|CONNECTION|SOCKET|PROTOCOL|ECONN|EPIPE|NETWORK/.test(serverError.code ?? '')) {
      throw new ConnectorError('completion-unknown', 'The connection failed after the write was dispatched. Reload the table before repeating it.');
    }
    throw error;
  }
}
