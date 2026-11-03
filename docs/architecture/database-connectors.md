# Database connector boundary

## Problem

The database plan supports eight engines with different request shapes and session lifecycles. The Electron shell already has a narrow preload API, but its shared contracts expose only profile operations. The connector layer must keep drivers and decrypted secrets in the main process, preserve the approved session union, and bound every result before it crosses IPC.

## Usage

```ts
const opened = await window.productivityApi.database.connect({ profileId });
if (!opened.ok) return showError(opened.error);

if (opened.value.kind === 'sql') {
  const result = await window.productivityApi.database.runSql({
    sessionId: opened.value.sessionId,
    sql: editorText,
    limit: 1000,
  });
}
```

The renderer receives only a serializable session descriptor and bounded result values. It never receives a driver, socket, or saved secret.

## Shape

The main process owns one application-level `ProfileStore`, `SecretStore`, `ConnectorRegistry`, and `DatabaseSessionManager`. The registry maps each fixed `DatabaseEngine` to one adapter. The session manager decrypts secrets, opens an adapter once per workspace, assigns an opaque session ID, validates ownership on every operation, and closes sessions on tab removal, window destruction, or app shutdown.

`DatabaseSession` is a discriminated union with SQL, MongoDB, Redis, and Memcached variants. Engine adapters keep dialect-specific SQL, TLS options, client objects, and value conversions private. IPC schemas validate every request; the manager accepts only typed requests. Errors are allowlisted and do not include driver messages that may contain credentials.

Adapters enforce the planned 10,000 row and 1 MiB cell limits while fetching. They also enforce a 16 MiB total page budget so a broad result cannot bypass the cell bound. MongoDB collection references include both database and collection names. Driver values use a closed serializable union that preserves decimals, big integers, timestamps, bytes, and extended JSON without unsafe coercion.

SQLite uses `sqlite3` for asynchronous file access and incremental row callbacks. The driver runs database work away from Electron's main event loop. The session manager owns the database handle and applies the same close and result rules.

## Synthesis decision

Candidate A provides the base: an in-process session manager, opaque handles, typed protocol variants, owner checks, and deterministic cleanup. Candidate B confirms that this matches the approved adapter plan and adds a clear unknown-completion result for operations canceled after dispatch. The separate worker-per-connection design was rejected because it adds process and serialization cost to every engine. An asynchronous SQLite driver removes the blocking risk without a worker process or a change to the network adapters' contract. No cross-family judge was available in the configured GPT-6 model pool.

## Tradeoffs accepted

- The in-process adapters use less memory and have a smaller transport surface, but a stuck async driver can delay shutdown until its close deadline.
- SQLite runs in a worker because synchronous calls can block the main process.
- A 16 MiB page budget limits unusually broad results in exchange for predictable memory use.
- Memcached exposes statistics and known-key get/set/delete only. It does not promise complete key enumeration.

## Alternatives considered

A worker process for every connection isolates driver crashes and synchronous calls. It also adds process startup, memory use, transport serialization, and a second request boundary for all eight engines. The focused SQLite worker keeps the useful isolation where the driver requires it.

A stateless command service that reconnects on every operation removes the session map. It also repeats credential decryption and connection setup, and cannot preserve session state. Workspace-owned sessions fit the SQL editor and cache browsers.

## Implementation reconciliation

The approved plan's `Result<T>` and `AppError` stay in `src/shared/contracts.ts` and are re-exported by connector contracts. The connector boundary adds a manager between IPC and adapters. It also adds page-byte limits and qualified MongoDB collection names from the design review.

## Open questions and risks

- Native SQLite package rebuilds depend on an available Electron ABI toolchain on the build machine.
- Memcached TLS is not exposed by the selected `memjs` driver. The UI and adapter must report TLS as unsupported instead of ignoring a saved TLS preference.

## Next implementation step

Define the shared connector contracts, IPC request schemas, registry, and application-owned service lifecycle before adding driver operations.
