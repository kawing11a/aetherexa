import type { DatabaseEngine } from './profiles.js';
import type { AppError, Result } from './contracts.js';

export type ConnectorCapabilities = {
  namespaces: boolean;
  objects: boolean;
  queryMode: 'sql' | 'document-filter' | 'redis-command' | 'memcached-key';
  readRows: boolean;
  exportRows: boolean;
};
export type Namespace = { name: string; kind: 'database' | 'schema' | 'collection'; databaseName?: string };
export type DatabaseObject = { name: string; kind: 'table' | 'view' | 'function' | 'index' | 'collection' };
export type ColumnDescriptor = { name: string; typeHint: string | null };
export type WireValue = null | boolean | number | string | Uint8Array | WireValue[] | { [key: string]: WireValue };
export type QueryPage = { columns: ColumnDescriptor[]; rows: WireValue[][]; truncated: boolean; truncationReason?: 'row-limit' | 'cell-limit' | 'page-byte-limit' };
export type TableIdentifier = { namespace: string; name: string };
export type TableColumn = {
  name: string;
  typeName: string;
  nullable: boolean;
  defaultExpression: string | null;
  primaryKeyOrder: number | null;
};
export type TableDefinition = { table: TableIdentifier; columns: TableColumn[] };
export type TableFilter =
  | { column: string; operator: 'equals' | 'contains'; value: WireValue }
  | { column: string; operator: 'is-null' | 'is-not-null' };
export type TablePageRequest = {
  table: TableIdentifier;
  offset: number;
  limit: number;
  sort?: { column: string; direction: 'asc' | 'desc' };
  filters: TableFilter[];
};
export type TablePage = {
  definition: TableDefinition;
  rows: WireValue[][];
  offset: number;
  limit: number;
  hasNext: boolean;
};
export type ColumnTypeOption = { name: string; label: string; argumentCount: number; minArgument: number; maxArgument: number };
export type NewTableColumn = {
  name: string;
  type: { name: string; arguments: number[] };
  nullable: boolean;
  default: { kind: 'none' } | { kind: 'literal'; value: WireValue } | { kind: 'current-timestamp' };
};
export type TableChange =
  | { kind: 'create'; table: TableIdentifier; columns: NewTableColumn[]; primaryKey: string[] }
  | { kind: 'add-column'; table: TableIdentifier; column: NewTableColumn }
  | { kind: 'rename-column'; table: TableIdentifier; from: string; to: string }
  | { kind: 'drop-column'; table: TableIdentifier; column: string };
export type RowInsert = { table: TableIdentifier; values: Record<string, WireValue> };
export type RowUpdate = { table: TableIdentifier; key: Record<string, WireValue>; expectedValues: Record<string, WireValue>; values: Record<string, WireValue> };
export type RowDelete = { table: TableIdentifier; key: Record<string, WireValue> };
export type DocumentPage = { documents: Record<string, WireValue>[]; truncated: boolean };
export type KeyPage = { keys: string[]; nextCursor: string | null };
export type RedisReply = { kind: 'scalar' | 'array' | 'map' | 'error'; value: WireValue };
export type MemcachedValue = { value: string | Uint8Array; flags: number; bytes: number };
export type MemcachedSetInput = { key: string; value: string | Uint8Array; ttlSeconds: number };
export type MongoFindInput = { database: string; collection: string; filter: Record<string, unknown>; projection?: Record<string, 0 | 1>; limit: number };
export type DatabaseSessionDescriptor = {
  sessionId: string;
  profileId: string;
  engine: DatabaseEngine;
  kind: 'sql' | 'mongodb' | 'redis' | 'memcached';
  capabilities: ConnectorCapabilities;
  endpointLabel: string;
};


export type SshSessionDescriptor = { sessionId: string; profileId: string; host: string; port: number };
export type HostKeyNotice = { requestId: string; profileId: string; host: string; port: number; currentFingerprint: string; previousFingerprint: string | null; changed: boolean };
export type TerminalDescriptor = { terminalId: string; sessionId: string; local: boolean };
export type TerminalData = { terminalId: string; data: string };
export type SftpEntry = { name: string; type: 'file' | 'directory' | 'link' | 'other'; size: number; modifiedAt: number; permissions: number };
export type TransferProgress = { transferId: string; direction: 'upload' | 'download'; fileName: string; transferredBytes: number; totalBytes: number | null; state: 'running' | 'completed' | 'failed' };
export interface SshApi {
  connect(input: { profileId: string }): Promise<Result<SshSessionDescriptor>>;
  disconnect(input: { sessionId: string }): Promise<Result<void>>;
  reviewHostKey(input: { requestId: string; accept: boolean; replaceChangedKey?: boolean }): Promise<Result<void>>;
  openTerminal(input: { sessionId: string; cols: number; rows: number }): Promise<Result<TerminalDescriptor>>;
  attachTerminal(input: { terminalId: string }): Promise<Result<void>>;
  openLocalTerminal(input: { cols: number; rows: number }): Promise<Result<TerminalDescriptor>>;
  writeTerminal(input: { terminalId: string; data: string }): Promise<Result<void>>;
  resizeTerminal(input: { terminalId: string; cols: number; rows: number }): Promise<Result<void>>;
  closeTerminal(input: { terminalId: string }): Promise<Result<void>>;
  onHostKey(listener: (notice: HostKeyNotice) => void): () => void;
  onTerminalData(listener: (event: TerminalData) => void): () => void;
  onDisconnect(listener: (event: { sessionId: string; message: string }) => void): () => void;
}
export interface SftpApi {
  open(input: { sessionId: string }): Promise<Result<{ sftpId: string }>>;
  list(input: { sftpId: string; path: string }): Promise<Result<SftpEntry[]>>;
  makeDirectory(input: { sftpId: string; path: string }): Promise<Result<void>>;
  rename(input: { sftpId: string; from: string; to: string }): Promise<Result<void>>;
  remove(input: { sftpId: string; path: string; directory: boolean }): Promise<Result<void>>;
  upload(input: { sftpId: string; remotePath: string }): Promise<Result<TransferProgress>>;
  download(input: { sftpId: string; remotePath: string }): Promise<Result<TransferProgress>>;
  onTransferProgress(listener: (event: TransferProgress) => void): () => void;
}

export interface DatabaseApi {
  connect(input: { profileId: string }): Promise<Result<DatabaseSessionDescriptor>>;
  close(input: { sessionId: string }): Promise<Result<void>>;
  cancel(input: { sessionId: string; operationId: string }): Promise<Result<void>>;
  listNamespaces(input: { sessionId: string }): Promise<Result<Namespace[]>>;
  listObjects(input: { sessionId: string; namespace: string }): Promise<Result<DatabaseObject[]>>;
  runSql(input: { sessionId: string; operationId: string; sql: string; limit: number }): Promise<Result<QueryPage>>;
  findDocuments(input: { sessionId: string; query: MongoFindInput }): Promise<Result<DocumentPage>>;
  scanKeys(input: { sessionId: string; pattern: string; cursor: string; count: number }): Promise<Result<KeyPage>>;
  executeRedis(input: { sessionId: string; tokens: string[] }): Promise<Result<RedisReply>>;
  getMemcachedStats(input: { sessionId: string }): Promise<Result<Record<string, string>>>;
  getMemcachedValue(input: { sessionId: string; key: string }): Promise<Result<MemcachedValue | null>>;
  setMemcachedValue(input: { sessionId: string; value: MemcachedSetInput }): Promise<Result<void>>;
  deleteMemcachedValue(input: { sessionId: string; key: string }): Promise<Result<void>>;
}

export type DatabaseSessionResult<T> = Result<T>;
export type DatabaseError = AppError;





