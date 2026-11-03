# Connector candidate B

This design supports the approved eight database and cache engines in the unified Windows app. It proposes a main-process connection broker with one utility process per open database workspace. Each utility process owns its driver and executes typed commands. This is a design candidate, not implemented behavior.

## Grounding

The approved database plan gives adapters a `DatabaseSession` union and places driver clients in the main process. `src/shared/contracts.ts` currently exposes profile operations only. `DatabaseProfile.options` in `src/shared/profiles.ts` is an unrestricted record of scalar options. `registerProfileHandlers` creates its own profile and secret stores. The connector implementation therefore needs an application-lifetime owner and a renderer contract before adding drivers.

## Caller's view

The renderer opens a saved profile and receives a descriptor containing an opaque connection ID, engine family, supported operations, and a safe endpoint label. It submits an operation with a renderer-generated request ID. It never receives a driver object or saved credential.

```ts
const opened = await api.database.open({ profileId });
if (!opened.ok || opened.value.kind !== 'sql') return;
const result = await api.database.sql.run({
  connectionId: opened.value.id,
  requestId: crypto.randomUUID(),
  sql: editorText,
});
await api.database.cancel({ connectionId: opened.value.id, requestId });
await api.database.close({ connectionId: opened.value.id });
```

The preload keeps named SQL, MongoDB, Redis, and Memcached methods. A discriminated command union is private to the main-to-worker transport. There is no renderer-supplied module name or reflected method dispatch.

```ts
type ConnectionState =
  | { phase: 'opening'; ownerId: number; profileId: string }
  | { phase: 'ready'; ownerId: number; descriptor: ConnectionDescriptor }
  | { phase: 'closing'; ownerId: number }
  | { phase: 'closed'; reason: CloseReason };

type WorkRequest =
  | { op: 'sql.run'; requestId: string; sql: string }
  | { op: 'mongo.find'; requestId: string; database: string;
      collection: string; filter: JsonObject; limit: number }
  | { op: 'redis.execute'; requestId: string; tokens: string[] }
  | { op: 'memcached.get'; requestId: string; key: string };
```

Other metadata and cache operations extend the closed union. Each operation has a corresponding typed response. The sketch shows the organizing structure rather than every operation.

## Ownership and cleanup

The application creates one `ConnectionBroker` beside the shared profile and secret stores. IPC handlers validate the sender, input schema, connection owner, and operation family before calling it. Boundary Discipline places these checks at IPC and worker-message boundaries. Driver-specific option parsing occurs before a socket opens.

The broker resolves the saved profile and decrypts its secret bundle. It sends the connection configuration to its utility process once. The driver process retains credentials only as required by the driver and does not log them. JavaScript strings cannot be reliably zeroed, so the design does not promise memory erasure. Worker responses contain normalized data and allowlisted error details.

Each workspace owns a distinct connection. Switching tabs preserves it. Closing a tab, destroying its web contents, or quitting the app cancels active requests and closes that connection. A deadline permits process termination when graceful closure stalls. A result arriving after close is discarded by connection ID and request ID. Connection IDs are not reused.

Cancellation requests first use the driver's cancellation operation. If termination is required, the result reports that command completion is unknown, closes the connection, and requires a fresh connection. It never retries the command. A driver process crash follows the same rule.

## Bounds and value representation

Retain the approved 10,000-row and 1 MiB-cell caps. Add a proposed 16 MiB total result budget, enforced during driver reads and before every process message. The total is a product policy proposal, not a measured optimum. A per-cell cap alone allows a result far larger than memory can safely hold. Redis command arguments and request text also need aggregate limits.

Use a closed wire value union for null, booleans, finite numbers, text, decimal strings, timestamps, bytes, and structured documents. Map driver objects to these values before transport. Big integers and decimals remain strings with type information. Binary values use byte arrays. MongoDB values need an explicit extended-JSON representation. Return truncation reasons and affected-row counts so a capped result and a successful mutation both have meaningful output.

MongoDB collection references include both database and collection names. The existing `Namespace` shape cannot distinguish identical collection names in different databases. Metadata pages also need bounds. Profile schemas should allow only engine-specific metadata keys, because the current arbitrary option record can persist a password-like field outside encrypted storage.

## Comparison with registry plus session union

| Criterion | Worker-owned connections | In-process registry plus session union |
| --- | --- | --- |
| API depth | The broker hides driver execution, crashes, deadlines, and transport. | A session hides engine details; a manager must still own cleanup and cancellation. |
| SQLite execution | Synchronous calls run away from Electron's main event loop. | `better-sqlite3` needs a dedicated execution worker to avoid blocking the main event loop. |
| Shutdown | The broker can terminate a stalled connection process. | A stalled driver may resist application cleanup. |
| Cost | Each live workspace adds process memory and startup latency. | Fewer processes and less serialization code. |
| Plan fit | Changes the approved location of live drivers and requires explicit reconciliation. | Matches the approved adapter contracts and file map. |

The complete worker design is strongest when driver crashes and synchronous execution are primary concerns. For the first implementation, I recommend retaining the approved registry plus session union, adding a broker as its lifetime owner, and isolating SQLite execution. This keeps the existing adapter contract and avoids making every network operation cross another process boundary. The total result budget, qualified MongoDB references, normalized wire values, and uncertain-completion outcome apply to either design.

I reject a stateless `execute(profileId, command)` interface that reconnects for every action. It hides connection cost but loses session state and transaction continuity, and forces credential decryption for repeated actions. I also reject a generic driver-method dispatcher because callers would depend on package-specific method names and return objects.

The first implementation unit should define the renderer connection descriptor, operation schemas, and broker lifetime rules. Then implement one SQL engine through that path before adding the other drivers. This candidate has been compared with the current plan and shared contracts. No runtime behavior is claimed, and no tests were run.
