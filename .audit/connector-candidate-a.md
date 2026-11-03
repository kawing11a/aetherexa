# Connector candidate A

The approved app needs one database workspace for each of MySQL/MariaDB, PostgreSQL, SQL Server, Oracle, SQLite, MongoDB, Redis, and Memcached. I recommend a main-owned `DatabaseSessionManager` with opaque session handles and four typed protocol session variants. Each workspace owns its connection. The manager owns credentials, operation lifetime, driver cleanup, and result limits.

## Caller usage

The renderer calls `database.connect({ profileId, workspaceId, operationId })` and receives a serializable descriptor containing `sessionId`, `profileId`, `engine`, `kind`, and capabilities. It then calls named methods such as `runSql`, `findDocuments`, `scanKeys`, or `getMemcachedValue`. The renderer sends an `operationId` before a long request so Cancel can address that operation while its promise remains pending. No request contains a driver name, driver instance, or saved secret.

## Recommended shape

```ts
type SessionKind = 'sql' | 'mongodb' | 'redis' | 'memcached';
type SessionDescriptor = {
	sessionId: SessionId;
	profileId: ProfileId;
	kind: SessionKind;
	engine: DatabaseEngine;
	capabilities: ConnectorCapabilities;
};

interface DatabaseSessionManager {
	connect(owner: OwnerId, input: ConnectInput): Promise<Result<SessionDescriptor>>;
	runSql(owner: OwnerId, input: RunSqlInput): Promise<Result<QueryPage>>;
	findDocuments(owner: OwnerId, input: FindDocumentsInput): Promise<Result<DocumentPage>>;
	cancel(owner: OwnerId, operationId: OperationId): Promise<Result<void>>;
	close(owner: OwnerId, sessionId: SessionId): Promise<Result<void>>;
	closeOwner(owner: OwnerId): Promise<void>;
	closeAll(): Promise<void>;
}
```

The concrete descriptor should be a discriminated union that ties each `kind` to its valid engines and capabilities. The approved adapter union remains internal to main. `Result` and `AppError` should come from the existing shared contracts rather than gain a second definition.

IPC handlers validate sender, request schema, session ownership, and the requested protocol variant. Engine option parsers validate persisted generic `options` before opening a connection. Internal adapter calls then receive typed options and an `AbortSignal`. This follows Boundary Discipline by keeping validation at IPC, storage, and driver boundaries.

The manager stores a session entry per workspace with a lifecycle of connecting, ready, or closing. It serializes operations on each connection. Editing a profile does not alter its active connection. Window destruction and app shutdown cancel owned operations and close each driver once. Use one application-owned `ProfileStore` and `SecretStore` instance across profile and database services. Current handlers create these stores inside registration at `src/main/ipc/profile-handlers.ts:15`, so a second service instance would introduce independent write queues.

Model the Domain and Type System Discipline favor the protocol union and branded IDs. They prevent a Memcached session from satisfying the SQL contract and prevent an operation ID from being used as a session ID. Capabilities describe supported actions. They do not replace protocol dispatch checks.

## Bounds that must apply during fetch

The plan specifies 10,000 rows and a 1 MiB cell limit at `docs/superpowers/plans/2026-11-03-database-and-cache-workspaces.md:109`. Add a total page byte budget, proposed at 16 MiB, plus metadata item limits. Fetch incrementally and stop or close the cursor when the first bound is reached. Slicing an already buffered driver result does not bound memory. SQLite's synchronous driver work belongs in a main-owned worker so a large query cannot block Electron's IPC thread.

Normalize driver values before IPC. Preserve large integers and exact decimals as tagged strings, dates as explicit timestamp values, and bytes as `Uint8Array`. Return a truncation reason when a limit removes data. Do not append a `LIMIT` clause to arbitrary submitted SQL or automatically retry a command after uncertain completion.

## Rejected alternative

A stateless service could open and close a driver for every request. That removes the session map but exposes connection setup, cancellation, session settings, and transaction continuity to callers. It also encourages hidden retries. Persistent workspace sessions keep those concerns behind one owner and match the approved query workspace contract.

## Concrete risks

`memjs` 1.3.2 defaults to `retries: 2` and `logger: console` in `node_modules/memjs/lib/memjs/memjs.js:18`. Disable retries and use a redacting or silent logger. Its transport imports `net` in `node_modules/memjs/lib/memjs/server.js:1`. No TLS support appears in the installed driver. Reject `tls: true` with an explicit unsupported-feature error instead of silently connecting without TLS. Memcached key enumeration remains outside its session interface.

The plan's prose declares `connect` without `Result` at line 35, while its concrete interface returns `Result` at line 102. Use the concrete interface consistently. MongoDB collection identities also need their database name, since collection names alone are ambiguous across databases.

This candidate is a source-grounded design proposal. It adds no implementation or tests.
