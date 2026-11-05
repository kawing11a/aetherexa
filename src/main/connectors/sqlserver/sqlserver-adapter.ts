import sql from 'mssql';
import { createHash } from 'node:crypto';
import type { DatabaseProfile, SecretBundle } from '@shared/profiles';
import type { Result } from '@shared/contracts';
import type { ColumnDescriptor, ColumnTypeOption, NewTableColumn, RowDelete, RowInsert, RowUpdate, TableChange, TableColumn, TableDefinition, TableIdentifier, TablePageRequest, WireValue } from '@shared/database';
import { ConnectorError, capture, ok, normalizeConnectorError } from '../connector-errors.js';
import type { DatabaseAdapter, DatabaseSession, SqlSession, SqlTableChangePlan, SqlTableOperations } from '../contracts.js';
import { optionalDatabase, password, requiredHost, requiredPort, requiredUsername, tlsEnabled } from '../relational/connection-options.js';
import { BoundedPageBuilder } from '../relational/row-normalizer.js';

const capabilities = { namespaces: true, objects: true, queryMode: 'sql' as const, readRows: true, exportRows: true };
export class SqlServerAdapter implements DatabaseAdapter {
  readonly engine = 'sqlserver' as const;
  async connect(profile: DatabaseProfile, secrets: SecretBundle): Promise<Result<DatabaseSession>> {
    try {
      const config: sql.config = { server: requiredHost(profile), port: requiredPort(profile, 1433), user: requiredUsername(profile), password: password(secrets), database: optionalDatabase(profile), connectionTimeout: 10_000, requestTimeout: 30_000, options: { encrypt: tlsEnabled(profile), trustServerCertificate: false, appName: 'Aetherexa' }, pool: { max: 2, min: 0, idleTimeoutMillis: 30_000 } };
      const pool = await new sql.ConnectionPool(config).connect();
      let tablePool: sql.ConnectionPool;
      try { tablePool = await new sql.ConnectionPool({ ...config, pool: { max: 1, min: 0, idleTimeoutMillis: 30_000 } }).connect(); }
      catch (error) { await pool.close().catch(() => undefined); throw error; }
      const session: SqlSession = {
        kind: 'sql', engine: this.engine, capabilities,
        tables: createTableOperations(tablePool),
        async close() { await Promise.all([pool.close(), tablePool.close()]); },
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

type ServerColumn = TableColumn & { baseType: string; identity: boolean; computed: boolean; maxLength: number; precision: number; scale: number };
type ServerTable = { definition: TableDefinition; columns: ServerColumn[]; objectId: number; schemaId: number; created: string; modified: string };
type SqlExecutor = sql.ConnectionPool | sql.Transaction;
const TYPE_OPTIONS: ColumnTypeOption[] = [
  { name: 'int', label: 'INT', argumentCount: 0, minArgument: 0, maxArgument: 0 },
  { name: 'bigint', label: 'BIGINT', argumentCount: 0, minArgument: 0, maxArgument: 0 },
  { name: 'bit', label: 'BIT', argumentCount: 0, minArgument: 0, maxArgument: 0 },
  { name: 'float', label: 'FLOAT', argumentCount: 0, minArgument: 0, maxArgument: 0 },
  { name: 'date', label: 'DATE', argumentCount: 0, minArgument: 0, maxArgument: 0 },
  { name: 'datetime2', label: 'DATETIME2', argumentCount: 0, minArgument: 0, maxArgument: 0 },
  { name: 'nvarchar', label: 'NVARCHAR', argumentCount: 1, minArgument: 1, maxArgument: 4000 },
  { name: 'varchar', label: 'VARCHAR', argumentCount: 1, minArgument: 1, maxArgument: 8000 },
  { name: 'varbinary', label: 'VARBINARY', argumentCount: 1, minArgument: 1, maxArgument: 8000 },
  { name: 'decimal', label: 'DECIMAL', argumentCount: 2, minArgument: 0, maxArgument: 38 },
];
const textTypes = new Set(['char', 'varchar', 'nchar', 'nvarchar']);
const intRanges: Record<string, [number, number]> = { tinyint: [0, 255], smallint: [-32768, 32767], int: [-2147483648, 2147483647] };
function failure(message: string, code = 'invalid-table-request'): never { throw new ConnectorError(code, message); }
function quote(name: string): string {
  if (!name || name.length > 128 || name.includes('\0')) return failure('The SQL Server identifier is invalid.');
  return '[' + name.replaceAll(']', ']]') + ']';
}
function reference(table: TableIdentifier): string { return quote(table.namespace) + '.' + quote(table.name); }
function literalString(value: string): string { return "N'" + value.replaceAll("'", "''") + "'"; }
function displayType(name: string, base: string, maxLength: number, precision: number, scale: number): string {
  if (name.toLowerCase() !== base) return name;
  if (['nvarchar', 'nchar', 'varchar', 'char', 'varbinary', 'binary'].includes(base)) {
    const length = maxLength < 0 ? 'max' : String(base.startsWith('n') ? maxLength / 2 : maxLength);
    return name + '(' + length + ')';
  }
  if (base === 'decimal' || base === 'numeric') return name + '(' + precision + ',' + scale + ')';
  if (['datetime2', 'datetimeoffset', 'time'].includes(base)) return name + '(' + scale + ')';
  return name;
}
function fingerprint(table: ServerTable | null): string {
  return createHash('sha256').update(JSON.stringify(table)).digest('hex');
}
async function describe(pool: SqlExecutor, table: TableIdentifier): Promise<ServerTable | null> {
  reference(table);
  const result = await pool.request().input('schema', sql.NVarChar(128), table.namespace).input('table', sql.NVarChar(128), table.name).query(`
    SELECT t.object_id, s.schema_id, t.create_date, t.modify_date, c.name, ty.name AS type_name, COALESCE(bt.name, ty.name) AS base_type, c.max_length, c.precision, c.scale,
           c.is_nullable, c.is_identity, c.is_computed, dc.definition AS default_expression, pk.key_ordinal
    FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
    JOIN sys.columns c ON c.object_id = t.object_id
    JOIN sys.types ty ON ty.user_type_id = c.user_type_id
    LEFT JOIN sys.types bt ON bt.user_type_id = c.system_type_id AND bt.system_type_id = c.system_type_id
    LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
    LEFT JOIN (SELECT ic.object_id, ic.column_id, ic.key_ordinal FROM sys.indexes i
      JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
      WHERE i.is_primary_key = 1 AND ic.key_ordinal > 0) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
    WHERE s.name = @schema AND t.name = @table ORDER BY c.column_id`);
  if (!result.recordset.length) return null;
  const columns: ServerColumn[] = result.recordset.map((row) => ({
    name: String(row.name), typeName: displayType(String(row.type_name), String(row.base_type).toLowerCase(), Number(row.max_length), Number(row.precision), Number(row.scale)), baseType: String(row.base_type).toLowerCase(),
    nullable: Boolean(row.is_nullable), defaultExpression: row.default_expression == null ? null : String(row.default_expression),
    primaryKeyOrder: row.key_ordinal == null ? null : Number(row.key_ordinal), identity: Boolean(row.is_identity),
    computed: Boolean(row.is_computed), maxLength: Number(row.max_length), precision: Number(row.precision), scale: Number(row.scale),
  }));
  return { definition: { table, columns: columns.map(({ name, typeName, nullable, defaultExpression, primaryKeyOrder }) => ({ name, typeName, nullable, defaultExpression, primaryKeyOrder })) }, columns, objectId: Number(result.recordset[0].object_id), schemaId: Number(result.recordset[0].schema_id), created: new Date(result.recordset[0].create_date).toISOString(), modified: new Date(result.recordset[0].modify_date).toISOString() };
}
async function requireSchema(pool: SqlExecutor, name: string): Promise<void> {
  quote(name);
  const result = await pool.request().input('schema', sql.NVarChar(128), name).query('SELECT 1 AS found FROM sys.schemas WHERE name = @schema');
  if (!result.recordset.length) failure('The schema no longer exists.', 'schema-not-found');
}
async function requireTable(pool: SqlExecutor, table: TableIdentifier): Promise<ServerTable> {
  return await describe(pool, table) ?? failure('The table no longer exists.', 'table-not-found');
}
function column(meta: ServerTable, name: string): ServerColumn {
  return meta.columns.find((item) => item.name === name) ?? failure('A selected column no longer exists.');
}
function primary(meta: ServerTable): ServerColumn[] {
  return meta.columns.filter((item) => item.primaryKeyOrder !== null).sort((a, b) => a.primaryKeyOrder! - b.primaryKeyOrder!);
}
function checkKey(meta: ServerTable, values: Record<string, WireValue>): ServerColumn[] {
  const keys = primary(meta);
  if (!keys.length) return failure('This table has no primary key and cannot be edited.', 'read-only-table');
  if (Object.keys(values).length !== keys.length || keys.some((key) => !Object.hasOwn(values, key.name) || values[key.name] === null)) return failure('All primary-key values are required.');
  return keys;
}
function bind(request: sql.Request, name: string, value: WireValue, info: ServerColumn): string {
  const type = info.baseType;
  if (value === null) { request.input(name, sql.NVarChar(sql.MAX), null); return '@' + name; }
  if (type in intRanges && typeof value === 'number' && Number.isInteger(value) && value >= intRanges[type][0] && value <= intRanges[type][1]) request.input(name, sql.Int, value);
  else if (type === 'bit' && typeof value === 'boolean') request.input(name, sql.Bit, value);
  else if ((type === 'float' || type === 'real') && typeof value === 'number' && Number.isFinite(value)) request.input(name, type === 'real' ? sql.Real : sql.Float, value);
  else if (textTypes.has(type) && typeof value === 'string') {
    if ((type === 'char' || type === 'varchar') && /[^\x00-\x7f]/.test(value)) return failure('Non-ASCII text cannot be safely written or compared in this column.', 'unsupported-feature');
    request.input(name, type === 'char' || type === 'varchar' ? sql.VarChar(sql.MAX) : sql.NVarChar(sql.MAX), value);
  }
  else if ((type === 'binary' || type === 'varbinary') && value instanceof Uint8Array) request.input(name, sql.VarBinary(sql.MAX), Buffer.from(value));
  else return failure('This value or column type cannot be safely edited or filtered.', 'unsupported-feature');
  return '@' + name;
}
function writable(meta: ServerTable, values: Record<string, WireValue>): ServerColumn[] {
  return Object.keys(values).map((name) => {
    const info = column(meta, name);
    if (info.identity || info.computed || info.baseType === 'timestamp' || info.baseType === 'rowversion') return failure('Generated columns cannot be edited.', 'unsupported-feature');
    return info;
  });
}
function rowPredicate(request: sql.Request, entries: ServerColumn[], values: Record<string, WireValue>, prefix: string, exact = false): string {
  return entries.map((info, index) => {
    const value = values[info.name];
    if (value === null) return quote(info.name) + ' IS NULL';
    const parameter = bind(request, prefix + index, value, info);
    if (exact && textTypes.has(info.baseType)) return 'CONVERT(VARBINARY(MAX), ' + quote(info.name) + ') = CONVERT(VARBINARY(MAX), ' + parameter + ')';
    return quote(info.name) + ' = ' + parameter;
  }).join(' AND ');
}
function ddlColumn(input: NewTableColumn): string {
  const type = TYPE_OPTIONS.find((item) => item.name === input.type.name);
  if (!type || input.type.arguments.length !== type.argumentCount || input.type.arguments.some((n) => !Number.isInteger(n) || n < type.minArgument || n > type.maxArgument)) return failure('Unsupported column type or arguments.');
  if (type.name === 'decimal' && (input.type.arguments[0] < 1 || input.type.arguments[1] > input.type.arguments[0])) return failure('Invalid decimal precision or scale.');
  const args = input.type.arguments.length ? '(' + input.type.arguments.join(',') + ')' : '';
  let defaultSql = '';
  if (input.default.kind === 'current-timestamp') {
    if (!['date', 'datetime2'].includes(type.name)) return failure('CURRENT_TIMESTAMP requires a date or datetime column.');
    defaultSql = ' DEFAULT CURRENT_TIMESTAMP';
  } else if (input.default.kind === 'literal') {
    const value = input.default.value;
    if (value === null) defaultSql = ' DEFAULT NULL';
    else if (typeof value === 'string' && ['nvarchar', 'varchar', 'date', 'datetime2'].includes(type.name)) {
      if (type.name === 'varchar' && /[^\x00-\x7f]/.test(value)) return failure('Non-ASCII defaults are unsupported for VARCHAR.', 'unsupported-feature');
      defaultSql = ' DEFAULT ' + literalString(value);
    }
    else if (typeof value === 'boolean' && type.name === 'bit') defaultSql = ' DEFAULT ' + (value ? '1' : '0');
    else if (typeof value === 'number' && Number.isFinite(value) && ['int', 'float'].includes(type.name) && (type.name !== 'int' || Number.isInteger(value) && value >= -2147483648 && value <= 2147483647)) defaultSql = ' DEFAULT ' + String(value);
    else return failure('This default value cannot be safely represented for the selected type.', 'unsupported-feature');
  }
  return quote(input.name) + ' ' + type.name.toUpperCase() + args + (input.nullable ? ' NULL' : ' NOT NULL') + defaultSql;
}
function statement(change: TableChange, meta: ServerTable | null): string {
  const target = reference(change.table);
  if (change.kind === 'create') {
    if (meta) return failure('The table already exists.', 'table-exists');
    if (!change.columns.length || change.columns.length > 256) return failure('A table requires columns.');
    const names = change.columns.map((item) => item.name);
    if (new Set(names).size !== names.length || new Set(change.primaryKey).size !== change.primaryKey.length) return failure('Column names and primary keys must be unique.');
    for (const key of change.primaryKey) if (!change.columns.some((item) => item.name === key && !item.nullable)) return failure('Primary-key columns must exist and be non-nullable.');
    return 'CREATE TABLE ' + target + ' (' + [...change.columns.map(ddlColumn), ...(change.primaryKey.length ? ['PRIMARY KEY (' + change.primaryKey.map(quote).join(', ') + ')'] : [])].join(', ') + ')';
  }
  if (!meta) return failure('The table no longer exists.', 'table-not-found');
  if (change.kind === 'add-column') {
    if (meta.columns.some((item) => item.name === change.column.name)) return failure('The column already exists.');
    return 'ALTER TABLE ' + target + ' ADD ' + ddlColumn(change.column);
  }
  column(meta, change.kind === 'rename-column' ? change.from : change.column);
  if (change.kind === 'drop-column') return 'ALTER TABLE ' + target + ' DROP COLUMN ' + quote(change.column);
  if (meta.columns.some((item) => item.name === change.to)) return failure('The column already exists.');
  quote(change.to);
  return 'EXEC sys.sp_rename ' + literalString(target + '.' + quote(change.from)) + ', ' + literalString(change.to) + ", N'COLUMN'";
}
function unknownMutation(error: unknown): never {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code !== 'EREQUEST') return failure('The write may have completed. Reload the table before retrying.', 'completion-unknown');
  throw error;
}
async function withWriteTransaction<T>(pool: sql.ConnectionPool, work: (transaction: sql.Transaction, dispatched: () => void) => Promise<T>): Promise<T> {
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  let sent = false;
  let value: T;
  try { value = await work(transaction, () => { sent = true; }); }
  catch (error) {
    try { await transaction.rollback(); } catch { if (sent) return failure('The write result is unknown. Reload the table before retrying.', 'completion-unknown'); }
    throw error;
  }
  try { await transaction.commit(); }
  catch { await transaction.rollback().catch(() => undefined); return failure('The write may have completed. Reload the table before retrying.', 'completion-unknown'); }
  return value;
}
async function lockTable(transaction: sql.Transaction, table: TableIdentifier): Promise<void> {
  await transaction.request().query('SELECT TOP (1) 1 AS locked FROM ' + reference(table) + ' WITH (TABLOCKX, HOLDLOCK)');
}
async function mutation(request: sql.Request, text: string, dispatched: () => void): Promise<{ affectedRows: number }> {
  let result: sql.IResult<unknown>;
  dispatched();
  try { result = await request.query(text + '; SELECT @@ROWCOUNT AS affectedRows'); } catch (error) { return unknownMutation(error); }
  const sets = result.recordsets as Array<Array<{ affectedRows?: unknown }>>;
  const affectedRows = Number(sets.at(-1)?.[0]?.affectedRows);
  if (!Number.isInteger(affectedRows) || affectedRows < 0) return failure('The write result is unknown. Reload the table before retrying.', 'completion-unknown');
  if (affectedRows === 0) return failure('The row changed or no longer exists. Reload the table.', 'stale-row');
  if (affectedRows !== 1) return failure('The write did not affect exactly one row.', 'row-count-mismatch');
  return { affectedRows };
}
function createTableOperations(pool: sql.ConnectionPool): SqlTableOperations {
  return {
    describeTable: (table) => capture(async () => (await requireTable(pool, table)).definition),
    listColumnTypes: async () => ok(TYPE_OPTIONS.map((item) => ({ ...item }))),
    readTablePage: (input: TablePageRequest) => capture(async () => {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200 || !Number.isInteger(input.offset) || input.offset < 0 || input.offset > 2_147_483_647 || input.filters.length > 10) return failure('Invalid page request.');
      const meta = await requireTable(pool, input.table);
      const request = pool.request();
      const predicates = input.filters.map((filter, index) => {
        const info = column(meta, filter.column);
        const name = quote(info.name);
        if (filter.operator === 'is-null') return name + ' IS NULL';
        if (filter.operator === 'is-not-null') return name + ' IS NOT NULL';
        if (filter.operator === 'contains') {
          if (!textTypes.has(info.baseType) || typeof filter.value !== 'string' || Buffer.byteLength(filter.value, 'utf8') > 4096) return failure('Contains requires a text column and a short string.');
          const escaped = filter.value.replace(/[\\%_\[]/g, (match) => '\\' + match);
          request.input('filter' + index, sql.NVarChar(sql.MAX), '%' + escaped + '%');
          return name + " LIKE @filter" + index + " ESCAPE N'\\'";
        }
        if (!('value' in filter)) return failure('Invalid filter operator.');
        if (filter.value === null || typeof filter.value === 'string' && Buffer.byteLength(filter.value, 'utf8') > 4096) return failure('Invalid equality filter.');
        return name + ' = ' + bind(request, 'filter' + index, filter.value, info);
      });
      const order: string[] = [];
      if (input.sort) {
        const info = column(meta, input.sort.column);
        if (!['asc', 'desc'].includes(input.sort.direction) || ['text', 'ntext', 'image', 'xml', 'geography', 'geometry', 'hierarchyid'].includes(info.baseType)) return failure('This column cannot be used for sorting.', 'unsupported-feature');
        order.push(quote(info.name) + (input.sort.direction === 'asc' ? ' ASC' : ' DESC'));
      }
      for (const key of primary(meta)) if (key.name !== input.sort?.column) order.push(quote(key.name) + ' ASC');
      if (!order.length) order.push('(SELECT NULL)');
      request.input('offset', sql.Int, input.offset).input('take', sql.Int, input.limit + 1);
      const query = 'SELECT ' + meta.columns.map((item, index) => quote(item.name) + ' AS ' + quote('c' + index)).join(', ') + ' FROM ' + reference(input.table) + (predicates.length ? ' WHERE ' + predicates.join(' AND ') : '') + ' ORDER BY ' + order.join(', ') + ' OFFSET @offset ROWS FETCH NEXT @take ROWS ONLY';
      const builder = new BoundedPageBuilder(meta.definition.columns.map((item) => ({ name: item.name, typeHint: item.typeName })), input.limit);
      let rowCount = 0; let exceeded = false;
      request.stream = true;
      await new Promise<void>((resolve, reject) => {
        request.on('row', (row) => {
          rowCount++;
          if (rowCount <= input.limit && !exceeded && !builder.push(meta.columns.map((_, index) => row['c' + index]))) exceeded = true;
        });
        request.on('error', reject);
        request.on('done', () => resolve());
        request.query(query);
      });
      if (exceeded) return failure('The table page exceeds the result size limit. Reduce the page size.', 'result-limit');
      return { definition: meta.definition, rows: builder.finish().rows, offset: input.offset, limit: input.limit, hasNext: rowCount > input.limit };
    }),
    planTableChange: (change) => capture(async () => {
      const meta = await describe(pool, change.table);
      if (change.kind === 'create') await requireSchema(pool, change.table.namespace);
      return { change, statements: [statement(change, meta)], destructive: change.kind === 'rename-column' || change.kind === 'drop-column', schemaFingerprint: fingerprint(meta) };
    }),
    applyTableChange: (plan: SqlTableChangePlan) => capture(async () => withWriteTransaction(pool, async (transaction, dispatched) => {
      if (plan.change.kind !== 'create') await lockTable(transaction, plan.change.table);
      const meta = await describe(transaction, plan.change.table);
      if (plan.change.kind === 'create') await requireSchema(transaction, plan.change.table.namespace);
      if (fingerprint(meta) !== plan.schemaFingerprint) return failure('The table definition changed. Preview the change again.', 'stale-table-plan');
      const current = statement(plan.change, meta);
      if (plan.statements.length !== 1 || plan.statements[0] !== current) return failure('The table change plan is invalid.');
      dispatched();
      try { await transaction.request().query(current); } catch (error) { return unknownMutation(error); }
    })),
    insertRow: (input: RowInsert) => capture(async () => withWriteTransaction(pool, async (transaction, dispatched) => {
      await lockTable(transaction, input.table);
      const meta = await requireTable(transaction, input.table);
      if (!primary(meta).length) return failure('This table has no primary key and cannot be edited.', 'read-only-table');
      const entries = writable(meta, input.values);
      const request = transaction.request();
      const text = entries.length ? 'INSERT INTO ' + reference(input.table) + ' (' + entries.map((item) => quote(item.name)).join(', ') + ') VALUES (' + entries.map((item, index) => bind(request, 'value' + index, input.values[item.name], item)).join(', ') + ')' : 'INSERT INTO ' + reference(input.table) + ' DEFAULT VALUES';
      return mutation(request, text, dispatched);
    })),
    updateRow: (input: RowUpdate) => capture(async () => withWriteTransaction(pool, async (transaction, dispatched) => {
      await lockTable(transaction, input.table);
      const meta = await requireTable(transaction, input.table);
      const keys = checkKey(meta, input.key);
      const entries = writable(meta, input.values);
      if (!entries.length || entries.length !== Object.keys(input.expectedValues).length || entries.some((item) => !Object.hasOwn(input.expectedValues, item.name))) return failure('Each edited column requires its original value.');
      const request = transaction.request();
      const assignments = entries.map((item, index) => quote(item.name) + ' = ' + bind(request, 'new' + index, input.values[item.name], item)).join(', ');
      const where = rowPredicate(request, keys, input.key, 'key') + ' AND ' + rowPredicate(request, entries, input.expectedValues, 'old', true);
      return mutation(request, 'UPDATE ' + reference(input.table) + ' SET ' + assignments + ' WHERE ' + where, dispatched);
    })),
    deleteRow: (input: RowDelete) => capture(async () => withWriteTransaction(pool, async (transaction, dispatched) => {
      await lockTable(transaction, input.table);
      const meta = await requireTable(transaction, input.table);
      const keys = checkKey(meta, input.key);
      const request = transaction.request();
      return mutation(request, 'DELETE FROM ' + reference(input.table) + ' WHERE ' + rowPredicate(request, keys, input.key, 'key'), dispatched);
    })),
  };
}
