# Database and Cache Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` or `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add working relational, document, and key/value workspaces for the eight database and cache engines in the approved design.

**Architecture:** Main-process adapters own network clients and expose bounded, typed results through the shared IPC boundary. Adapter capability declarations drive engine-specific UI behavior; query surfaces are not forced into one misleading SQL abstraction.

**Tech Stack:** TypeScript, per-engine Node protocol drivers selected after package/license review, React workspaces, and a virtualized result grid where result volume requires it.

## Global Constraints

- Support MySQL/MariaDB, PostgreSQL, SQL Server, Oracle, SQLite, MongoDB, Redis, and Memcached.
- Do not send credentials to the renderer or log them.
- Do not automatically retry potentially mutating commands after uncertain completion.
- Bound query output and keep result rendering responsive.
- No automated tests are added or run unless the user asks for testing or verification.

---

### Task 1: Define connector contracts and package decisions

**Files:**
- Create: `src/main/connectors/contracts.ts`
- Create: `src/main/connectors/connector-registry.ts`
- Create: `src/main/connectors/connector-errors.ts`
- Create: `src/main/ipc/database-handlers.ts`
- Create: `docs/dependencies.md`
- Modify: `src/shared/contracts.ts`
- Modify: `src/shared/profiles.ts`
- Modify: `src/main/ipc/register-handlers.ts`

**Interfaces:**
- `ConnectorCapabilities` reports `namespaces`, `objects`, `queryMode`, `readRows`, and `exportRows` per engine.
- `DatabaseAdapter.connect(profile: DatabaseProfile, secrets: SecretBundle): Promise<DatabaseSession>` creates one session for one validated profile.
- `DatabaseSession` is a discriminated union; every member exposes `engine`, `capabilities`, and `close()`, while SQL, MongoDB, Redis, and Memcached sessions expose only their own operations.

Define the contracts in `src/main/connectors/contracts.ts`:

```ts
export type AppError = { code: string; message: string; retryable: boolean };
export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };
export type ConnectorCapabilities = {
  namespaces: boolean;
  objects: boolean;
  queryMode: 'sql' | 'document-filter' | 'redis-command' | 'memcached-key';
  readRows: boolean;
  exportRows: boolean;
};
export type Namespace = { name: string; kind: 'database' | 'schema' | 'collection' };
export type DatabaseObject = { name: string; kind: 'table' | 'view' | 'function' | 'index' };
export type ColumnDescriptor = { name: string; typeHint: string | null };
export type QueryPage = { columns: ColumnDescriptor[]; rows: unknown[][]; truncated: boolean };
export type DocumentPage = { documents: Record<string, unknown>[]; truncated: boolean };
export type KeyPage = { keys: string[]; nextCursor: string | null };
export type RedisReply = { kind: 'scalar' | 'array' | 'map' | 'error'; value: unknown };
export type MemcachedValue = { value: string | Uint8Array; flags: number; bytes: number };
export type MemcachedSetInput = { key: string; value: string | Uint8Array; ttlSeconds: number };
export type MongoFindInput = {
  collection: string;
  filter: Record<string, unknown>;
  projection?: Record<string, 0 | 1>;
  limit: number;
};
export type BaseSession = {
  engine: DatabaseEngine;
  capabilities: ConnectorCapabilities;
  close(): Promise<void>;
};

export type SqlSession = BaseSession & {
  kind: 'sql';
  listNamespaces(signal?: AbortSignal): Promise<Result<Namespace[]>>;
  listObjects(namespace: string, signal?: AbortSignal): Promise<Result<DatabaseObject[]>>;
  runSql(sql: string, signal?: AbortSignal): Promise<Result<QueryPage>>;
};

export type MongoSession = BaseSession & {
  kind: 'mongodb';
  listNamespaces(signal?: AbortSignal): Promise<Result<Namespace[]>>;
  findDocuments(input: MongoFindInput, signal?: AbortSignal): Promise<Result<DocumentPage>>;
};

export type RedisSession = BaseSession & {
  kind: 'redis';
  scanKeys(pattern: string, cursor: string, count: number, signal?: AbortSignal): Promise<Result<KeyPage>>;
  executeCommand(tokens: string[], signal?: AbortSignal): Promise<Result<RedisReply>>;
};

export type MemcachedSession = BaseSession & {
  kind: 'memcached';
  getStats(signal?: AbortSignal): Promise<Result<Record<string, string>>>;
  getValue(key: string, signal?: AbortSignal): Promise<Result<MemcachedValue | null>>;
  setValue(input: MemcachedSetInput, signal?: AbortSignal): Promise<Result<void>>;
  deleteValue(key: string, signal?: AbortSignal): Promise<Result<void>>;
};

export type DatabaseSession = SqlSession | MongoSession | RedisSession | MemcachedSession;

export interface DatabaseAdapter {
  readonly engine: DatabaseEngine;
  connect(profile: DatabaseProfile, secrets: SecretBundle): Promise<Result<DatabaseSession>>;
}
```
- `ConnectorRegistry.get(engine): DatabaseAdapter` fails with `unsupported-engine` when no adapter is registered.

- [ ] Select exact adapter packages only after checking maintainer documentation, current package health, native/runtime requirements, and license; record package names, pinned versions, and license notices in `docs/dependencies.md`.
- [ ] Define every contract type in the block above in `src/main/connectors/contracts.ts` and export it for adapter implementations and IPC result mapping.
- [ ] Define `MAX_RESULT_ROWS = 10000` and `MAX_CELL_BYTES = 1048576`; adapters return a `truncated` flag when limits are reached.
- [ ] Define normalized errors for authentication, network, TLS, timeout, invalid input, unsupported feature, and server response.
- [ ] Add a connector registry that receives adapters at construction and never creates a driver from renderer-supplied module names.

### Task 2: Implement relational adapters

**Files:**
- Create: `src/main/connectors/mysql/mysql-adapter.ts`
- Create: `src/main/connectors/postgres/postgres-adapter.ts`
- Create: `src/main/connectors/sqlserver/sqlserver-adapter.ts`
- Create: `src/main/connectors/oracle/oracle-adapter.ts`
- Create: `src/main/connectors/sqlite/sqlite-adapter.ts`
- Create: `src/main/connectors/relational/row-normalizer.ts`
- Create: `src/main/connectors/relational/connection-options.ts`
- Modify: `src/main/connectors/connector-registry.ts`
- Modify: `src/main/ipc/database-handlers.ts`
- Modify: `package.json`

**Interfaces:**
- Each adapter implements the shared `DatabaseAdapter` contract and declares its own object/namespace terminology.
- `normalizeRows(columns, rows, limit): QueryPage` preserves nulls, byte values, timestamps, and large integers without unsafe precision loss.
- `buildConnectionOptions(profile, secret): DriverOptions` rejects malformed ports, incompatible TLS values, and missing required fields before opening a socket.

- [ ] Implement MySQL/MariaDB and PostgreSQL first, including connect, disconnect, schema listing, table/view listing, `runSql`, cancellation where supported, and bounded rows.
- [ ] Implement SQL Server, Oracle, and SQLite adapters against the same public contract while keeping engine-specific SQL and connection options inside each adapter.
- [ ] Use parameterized metadata queries where a driver supports them; do not concatenate user data into metadata SQL.
- [ ] Ensure query results keep column names and type hints and do not coerce large numeric values to JavaScript `number` when precision would be lost.
- [ ] Keep SQLite profile paths scoped to a user-selected local file and clearly display the resolved file path in the connection editor.

### Task 3: Implement relational connection, object, editor, and result UI

**Files:**
- Create: `src/renderer/workspaces/sql/SqlWorkspace.tsx`
- Create: `src/renderer/workspaces/sql/SqlEditor.tsx`
- Create: `src/renderer/workspaces/sql/ResultsGrid.tsx`
- Create: `src/renderer/workspaces/sql/ObjectTree.tsx`
- Create: `src/renderer/workspaces/sql/ConnectionDialog.tsx`
- Create: `src/renderer/state/database-sessions.ts`
- Create: `src/renderer/styles/sql-workspace.css`
- Modify: `src/renderer/components/ConnectionSidebar.tsx`
- Modify: `src/preload/index.ts`
- Modify: `src/main/ipc/register-handlers.ts`

**Interfaces:**
- `SqlWorkspace` receives `profileId` and uses `database.connect/listNamespaces/listObjects/run/close` commands.
- `ResultsGrid` receives `{ columns, rows, truncated }` and never owns a live driver object.
- `ConnectionDialog` returns a validated `ConnectionProfile` plus a one-time secret input; it never stores the secret in renderer profile state.

- [ ] Add connection forms with engine-specific fields and an explicit TLS/certificate section where applicable.
- [ ] Add schema/object tree and query editor with Run and Cancel actions; keep the editor text when a query fails or connection drops.
- [ ] Add a results grid with column resize, bounded initial rendering, horizontal scrolling, and a locally generated CSV export.
- [ ] Show engine capability messages beside disabled actions rather than displaying a no-op control.

### Task 4: Implement MongoDB collection and document workspace

**Files:**
- Create: `src/main/connectors/mongodb/mongodb-adapter.ts`
- Create: `src/renderer/workspaces/mongodb/MongoWorkspace.tsx`
- Create: `src/renderer/workspaces/mongodb/DocumentGrid.tsx`
- Create: `src/renderer/workspaces/mongodb/FilterEditor.tsx`
- Modify: `src/main/connectors/connector-registry.ts`
- Modify: `src/main/ipc/database-handlers.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- `MongoSession.listNamespaces(signal?)` returns database and collection descriptors.
- `MongoSession.findDocuments({ collection, filter, projection, limit }, signal?)` returns typed JSON documents and a truncation indicator.

- [ ] Implement MongoDB connection validation, database/collection listing, bounded document find, and explicit close.
- [ ] Render JSON-aware filters and document rows; reject invalid JSON before sending a command.
- [ ] Keep write operations outside the first baseline workspace unless the user requests them in a later scope update.

### Task 5: Implement Redis key and command workspace

**Files:**
- Create: `src/main/connectors/redis/redis-adapter.ts`
- Create: `src/renderer/workspaces/redis/RedisWorkspace.tsx`
- Create: `src/renderer/workspaces/redis/RedisKeyBrowser.tsx`
- Create: `src/renderer/workspaces/redis/RedisCommandEditor.tsx`
- Modify: `src/main/connectors/connector-registry.ts`
- Modify: `src/main/ipc/database-handlers.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- `RedisSession.scanKeys(pattern, cursor, count, signal?)` returns one bounded page and the next cursor.
- `RedisSession.executeCommand(tokens, signal?)` returns a tagged Redis value; credentials are not accepted inside command text.

- [ ] Implement Redis connection/auth/TLS options, paged key browsing, type-aware value reads, server info summary, and command execution.
- [ ] Parse command input into tokens and reject commands that embed a profile secret; keep command output size bounded.
- [ ] Clearly label potentially mutating commands and never retry them automatically.

### Task 6: Implement Memcached statistics and value workspace

**Files:**
- Create: `src/main/connectors/memcached/memcached-adapter.ts`
- Create: `src/renderer/workspaces/memcached/MemcachedWorkspace.tsx`
- Create: `src/renderer/workspaces/memcached/StatsPanel.tsx`
- Create: `src/renderer/workspaces/memcached/ValueLookup.tsx`
- Modify: `src/main/connectors/connector-registry.ts`
- Modify: `src/main/ipc/database-handlers.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- `MemcachedSession.getStats(signal?)` returns a typed stats map.
- `MemcachedSession.getValue(key, signal?)` returns the value and flags; enumeration is not part of the interface.

- [ ] Implement server statistics and get/set/delete for keys with explicit TTL and byte-size limits.
- [ ] Make the UI explain that Memcached does not provide a general key enumeration operation; do not imply search can discover arbitrary keys.
- [ ] Keep key mutations explicit and show the target endpoint and key before applying them.

