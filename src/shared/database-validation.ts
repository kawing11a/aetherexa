import { z } from 'zod';

const session = z.object({ sessionId: z.string().uuid() }).strict();
export const databaseConnectSchema = z.object({ profileId: z.string().uuid() }).strict();
export const databaseCloseSchema = session;
export const namespaceListSchema = session;
export const objectListSchema = session.extend({ namespace: z.string().max(512) });
export const runSqlSchema = session.extend({ sql: z.string().min(1).max(500_000), limit: z.number().int().min(1).max(10_000) });
export const findDocumentsSchema = session.extend({ query: z.object({ database: z.string().min(1).max(255), collection: z.string().min(1).max(255), filter: z.record(z.string().max(255), z.unknown()), projection: z.record(z.string().max(255), z.union([z.literal(0), z.literal(1)])).optional(), limit: z.number().int().min(1).max(10_000) }).strict() });
export const scanKeysSchema = session.extend({ pattern: z.string().max(1024), cursor: z.string().max(128), count: z.number().int().min(1).max(1000) });
export const redisCommandSchema = session.extend({ tokens: z.array(z.string().max(16_384)).min(1).max(100) }).refine((input) => input.tokens.reduce((total, token) => total + new TextEncoder().encode(token).byteLength, 0) <= 65_536, { message: 'Command exceeds the size limit.' });
export const memcachedStatsSchema = session;
export const memcachedKeySchema = session.extend({ key: z.string().min(1).max(250) });
export const memcachedSetSchema = session.extend({ value: z.object({ key: z.string().min(1).max(250), value: z.union([z.string(), z.instanceof(Uint8Array)]), ttlSeconds: z.number().int().min(0).max(2_592_000) }).strict() }).refine((input) => typeof input.value.value === 'string' ? new TextEncoder().encode(input.value.value).byteLength <= 1_048_576 : input.value.value.byteLength <= 1_048_576, { message: 'Value exceeds the 1 MiB limit.' });

const MAX_TABLE_COLUMNS = 256;
const MAX_TABLE_VALUE_BYTES = 1_048_576;
const MAX_TABLE_REQUEST_VALUE_BYTES = 4 * 1_048_576;
const textBytes = (value: string) => new TextEncoder().encode(value).byteLength;
const identifier = z.string().min(1).max(512).refine((value) => !value.includes('\0'), 'Identifiers cannot contain NUL.');
const tableIdentifierSchema = z.object({ namespace: identifier, name: identifier }).strict();
const scalar = z.union([
  z.boolean(), z.number().finite(),
  z.string().max(MAX_TABLE_VALUE_BYTES).refine((value) => textBytes(value) <= MAX_TABLE_VALUE_BYTES),
  z.instanceof(Uint8Array).refine((value) => value.byteLength <= MAX_TABLE_VALUE_BYTES),
]);
const cell = scalar.nullable();
function valueBytes(value: z.infer<typeof cell>): number {
  if (typeof value === 'string') return textBytes(value);
  if (value instanceof Uint8Array) return value.byteLength;
  return 8;
}
const rowValues = z.record(identifier, cell).refine((values) => Object.keys(values).length <= MAX_TABLE_COLUMNS, 'Too many column values.');
const keyValues = rowValues.refine((values) => Object.keys(values).length > 0, 'Primary-key values are required.');
const filterText = z.string().max(4096).refine((value) => textBytes(value) <= 4096);
const tableFilterSchema = z.discriminatedUnion('operator', [
  z.object({ column: identifier, operator: z.literal('equals'), value: scalar.refine((value) => typeof value !== 'string' || textBytes(value) <= 4096) }).strict(),
  z.object({ column: identifier, operator: z.literal('contains'), value: filterText }).strict(),
  z.object({ column: identifier, operator: z.literal('is-null') }).strict(),
  z.object({ column: identifier, operator: z.literal('is-not-null') }).strict(),
]);
const newTableColumnSchema = z.object({
  name: identifier,
  type: z.object({ name: identifier, arguments: z.array(z.number().int().min(0).max(2_147_483_647)).max(2) }).strict(),
  nullable: z.boolean(),
  default: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }).strict(),
    z.object({ kind: z.literal('literal'), value: cell }).strict(),
    z.object({ kind: z.literal('current-timestamp') }).strict(),
  ]),
}).strict();
export const tableChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), table: tableIdentifierSchema, columns: z.array(newTableColumnSchema).min(1).max(MAX_TABLE_COLUMNS), primaryKey: z.array(identifier).max(MAX_TABLE_COLUMNS) }).strict(),
  z.object({ kind: z.literal('add-column'), table: tableIdentifierSchema, column: newTableColumnSchema }).strict(),
  z.object({ kind: z.literal('rename-column'), table: tableIdentifierSchema, from: identifier, to: identifier }).strict(),
  z.object({ kind: z.literal('drop-column'), table: tableIdentifierSchema, column: identifier }).strict(),
]).refine((change) => {
  const columns = change.kind === 'create' ? change.columns : change.kind === 'add-column' ? [change.column] : [];
  return columns.reduce((total, column) => total + (column.default.kind === 'literal' ? valueBytes(column.default.value) : 0), 0) <= MAX_TABLE_REQUEST_VALUE_BYTES;
}, 'Default values exceed the request size limit.');
export const describeTableSchema = session.extend({ table: tableIdentifierSchema }).strict();
export const listColumnTypesSchema = session;
export const readTablePageSchema = session.extend({ request: z.object({
  table: tableIdentifierSchema,
  offset: z.number().int().min(0).max(2_147_483_647),
  limit: z.number().int().min(1).max(200),
  sort: z.object({ column: identifier, direction: z.enum(['asc', 'desc']) }).strict().optional(),
  filters: z.array(tableFilterSchema).max(10),
}).strict() }).strict().refine(({ request }) => request.filters.reduce((total, filter) => total + ('value' in filter ? valueBytes(filter.value) : 0), 0) <= MAX_TABLE_REQUEST_VALUE_BYTES, 'Filter values exceed the request size limit.');
export const previewTableChangeSchema = session.extend({ change: tableChangeSchema }).strict();
export const applyTableChangeSchema = session.extend({ planId: z.string().uuid(), confirmDestructive: z.boolean() }).strict();
export const insertRowSchema = session.extend({ input: z.object({ table: tableIdentifierSchema, values: rowValues }).strict() }).strict()
  .refine(({ input }) => Object.values(input.values).reduce<number>((total, value) => total + valueBytes(value), 0) <= MAX_TABLE_REQUEST_VALUE_BYTES, 'Values exceed the request size limit.');
export const updateRowSchema = session.extend({ input: z.object({ table: tableIdentifierSchema, key: keyValues, expectedValues: keyValues, values: keyValues }).strict() }).strict()
  .refine(({ input }) => [input.key, input.expectedValues, input.values].reduce<number>((total, values) => total + Object.values(values).reduce<number>((sum, value) => sum + valueBytes(value), 0), 0) <= MAX_TABLE_REQUEST_VALUE_BYTES, 'Values exceed the request size limit.')
  .refine(({ input }) => Object.keys(input.values).length === Object.keys(input.expectedValues).length && Object.keys(input.values).every((column) => Object.hasOwn(input.expectedValues, column)), 'Each edited column requires its old value.');
export const deleteRowSchema = session.extend({ input: z.object({ table: tableIdentifierSchema, key: keyValues }).strict() }).strict()
  .refine(({ input }) => Object.values(input.key).reduce<number>((total, value) => total + valueBytes(value), 0) <= MAX_TABLE_REQUEST_VALUE_BYTES, 'Values exceed the request size limit.');

export const sshConnectSchema = z.object({ profileId: z.string().uuid() }).strict();
export const hostKeyReviewSchema = z.object({ requestId: z.string().uuid(), accept: z.boolean(), replaceChangedKey: z.boolean().optional() }).strict();
export const terminalOpenSchema = z.object({ sessionId: z.string().uuid(), cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }).strict();
export const localTerminalOpenSchema = z.object({ cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }).strict();
export const terminalIdSchema = z.object({ terminalId: z.string().uuid() }).strict();
export const terminalWriteSchema = terminalIdSchema.extend({ data: z.string().max(16384) }).strict();
export const terminalResizeSchema = terminalIdSchema.extend({ cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }).strict();
export const sftpOpenSchema = z.object({ sessionId: z.string().uuid() }).strict();
export const sftpListSchema = z.object({ sftpId: z.string().uuid(), path: z.string().max(4096) }).strict();
export const sftpRenameSchema = z.object({ sftpId: z.string().uuid(), from: z.string().max(4096), to: z.string().max(4096) }).strict();
export const sftpRemoveSchema = z.object({ sftpId: z.string().uuid(), path: z.string().max(4096), directory: z.boolean() }).strict();
export const sftpPathSchema = z.object({ sftpId: z.string().uuid(), path: z.string().max(4096) }).strict();
export const sftpTransferSchema = z.object({ sftpId: z.string().uuid(), remotePath: z.string().min(1).max(4096) }).strict();
export const sftpLocalListSchema = z.object({ path: z.string().max(4096).optional() }).strict();
export const sftpUploadPathsSchema = z.object({ sftpId: z.string().uuid(), remoteDirectory: z.string().min(1).max(4096), localPaths: z.array(z.string().min(1).max(4096)).min(1).max(100) }).strict();
export const sftpDownloadLocalSchema = z.object({ sftpId: z.string().uuid(), remotePath: z.string().min(1).max(4096), localDirectory: z.string().min(1).max(4096) }).strict();
export const sftpArchiveSchema = z.object({ sftpId: z.string().uuid(), remotePath: z.string().min(1).max(4096), format: z.enum(['zip', 'tar', 'tar.gz']) }).strict();
export const fileConnectSchema = z.object({ profileId: z.string().uuid() }).strict();
export const fileSessionSchema = z.object({ sessionId: z.string().uuid() }).strict();
export const filePathSchema = fileSessionSchema.extend({ path: z.string().max(4096) }).strict();
export const fileTransferSchema = fileSessionSchema.extend({ path: z.string().min(1).max(4096) }).strict();
export const fileRemoveSchema = filePathSchema.extend({ directory: z.boolean() }).strict();
export const fileHostKeyReviewSchema = z.object({ requestId: z.string().uuid(), accept: z.boolean(), replaceChangedKey: z.boolean().optional() }).strict();
