# SQL editor and table tools implementation plan

> **For agentic workers:** The root owner implements shared contracts, IPC, and relational adapters. Delegate the renderer-only tasks in an isolated worktree after the contracts are committed. Keep each unit on branch `codex/query-table-tools` and do not add or run tests unless the user asks.

**Goal:** Add SQL formatting and session query history, paged table browsing, table design, and primary-key row editing for Aetherexa's five relational engines.

**Architecture:** Keep editor state in the renderer and database behavior in the main-process relational adapters. Add typed requests through `DatabaseApi`, preload IPC, validation, `DatabaseSessionManager`, and each `SqlSession`. Adapters own metadata queries, identifiers, pagination, DDL, and parameter binding.

**Tech Stack:** Electron, React, TypeScript, Zod, MySQL2, PostgreSQL, SQL Server, Oracle, SQLite, `sql-formatter` 15.9.0.

## Global constraints

- Support MySQL/MariaDB, PostgreSQL, SQL Server, Oracle, and SQLite.
- Keep the query history in renderer memory for the workspace lifetime, with a 50-statement cap.
- Bound table pages to 200 rows, 10 filters, 4 KiB text filter values, and an offset no greater than 2,147,483,647.
- Keep all driver objects, connections, metadata queries, SQL generation, value binding, and mutations in the main process.
- Quote identifiers only after validating them against live metadata. Bind all filter and row values.
- Disable row writes when the table has no primary key. Include old edited values in updates to reject stale edits.
- Preview DDL through a plan ID that expires after five minutes, belongs to one session owner, and can be applied once.
- Require destructive confirmation for column rename/drop and row deletion. Never retry mutations automatically.
- Do not persist query text across app restarts. Do not include user query values in logs or error messages.
- Do not add database backups, BI reports, visual models, query tabs, saved queries, view editing, stored procedure editing, bulk row operations, or non-SQL table tools.
- Do not add or run tests unless the user asks. Typecheck and build commands are not test suites.

---

## File map

- `src/shared/database.ts` owns the serialized table request and result shapes shared by the renderer, preload, and main process.
- `src/shared/database-validation.ts` owns Zod bounds and request validation.
- `src/main/connectors/contracts.ts` owns SQL-session operation signatures and the internal DDL plan type.
- `src/main/connectors/database-session-manager.ts` owns session/owner checks, operation serialization, and one-use DDL plans.
- `src/main/ipc/database-handlers.ts` owns validated IPC handlers for table operations.
- `src/preload/index.ts` exposes the typed table operations without exposing Electron internals.
- `src/main/connectors/mysql/mysql-adapter.ts`, `postgres/postgres-adapter.ts`, `sqlserver/sqlserver-adapter.ts`, `oracle/oracle-adapter.ts`, and `sqlite/sqlite-adapter.ts` own each dialect's metadata and SQL.
- `src/renderer/workspaces/sql/SqlWorkspace.tsx` owns query text, run state, session history, table selection, and error display.
- `src/renderer/workspaces/sql/TableBrowser.tsx` owns table page, sort, and filter controls.
- `src/renderer/workspaces/sql/TableDesignerDialog.tsx` owns create/alter forms, DDL preview, and destructive confirmation.
- `src/renderer/workspaces/sql/EditableTableGrid.tsx` owns row display and insert/update/delete interactions.
- `src/renderer/styles/database-workspaces.css` owns styles for the new SQL controls and dialogs.
- `package.json` and `package-lock.json` pin `sql-formatter` 15.9.0.
- `docs/dependencies.md` records the formatter's license and purpose.
- `docs/user-guide.md` documents the SQL editor, table browser, and row/design limits.

## Task 1: Add shared table domain types

**Files:**
- Modify: `src/shared/database.ts`
- Modify: `src/main/connectors/contracts.ts`

**Interfaces:**
- `TableIdentifier = { namespace: string; name: string }`
- `TableColumn = { name: string; typeName: string; nullable: boolean; defaultExpression: string | null; primaryKeyOrder: number | null }`
- `TableDefinition = { table: TableIdentifier; columns: TableColumn[] }`
- `TableFilter` is a discriminated union for `equals`, `contains`, `is-null`, and `is-not-null`.
- `TablePageRequest = { table: TableIdentifier; offset: number; limit: number; sort?: { column: string; direction: 'asc' | 'desc' }; filters: TableFilter[] }`
- `TablePage = { definition: TableDefinition; rows: WireValue[][]; offset: number; limit: number; hasNext: boolean }`
- `ColumnTypeOption` gives a validated engine type name, display label, argument count, and argument bounds.
- `NewTableColumn` carries a type name and numeric type arguments, nullability, and a typed default (`none`, `literal`, or `current-timestamp`).
- `TableChange` supports `create`, `add-column`, `rename-column`, and `drop-column`.
- `TableChangePreview = { planId: string; statements: string[]; destructive: boolean }` is the renderer-visible part of an internal one-use `SqlTableChangePlan`.
- `RowInsert`, `RowUpdate`, and `RowDelete` use column maps and primary-key maps. `RowUpdate` also carries old edited values.
- `SqlSession` adds `describeTable(table)`, `listColumnTypes()`, `readTablePage(request)`, `planTableChange(change)`, `applyTableChange(plan)`, `insertRow(input)`, `updateRow(input)`, and `deleteRow(input)`. Each returns `Promise<Result<T>>` and reads accept optional `AbortSignal` values.

**Steps:**

- [ ] Add the shared table types beside `QueryPage` and retain `WireValue` for cells and filter values.
- [ ] Add an internal `SqlTableChangePlan` with exact statements, target table, destructive flag, and schema fingerprint.
- [ ] Extend `SqlSession` with the matching asynchronous methods and optional abort signals for reads.
- [ ] Run `npm run typecheck` to find current SQL session implementations that no longer satisfy the interface.

## Task 2: Wire table operations through IPC

**Files:**
- Modify: `src/shared/database.ts`
- Modify: `src/shared/database-validation.ts`
- Modify: `src/main/connectors/database-session-manager.ts`
- Modify: `src/main/ipc/database-handlers.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- `DatabaseApi.describeTable({ sessionId, table }) -> Result<TableDefinition>`
- `DatabaseApi.listColumnTypes({ sessionId }) -> Result<ColumnTypeOption[]>`
- `DatabaseApi.readTablePage({ sessionId, request }) -> Result<TablePage>`
- `DatabaseApi.previewTableChange({ sessionId, change }) -> Result<TableChangePreview>`
- `DatabaseApi.applyTableChange({ sessionId, planId, confirmDestructive }) -> Result<void>`
- `DatabaseApi.insertRow({ sessionId, input })`, `updateRow({ sessionId, input })`, and `deleteRow({ sessionId, input })` return `Result<{ affectedRows: number }>`.

**Steps:**

- [ ] Add strict Zod schemas for every table request. Enforce the global page, filter, offset, identifier, and collection-size limits.
- [ ] Validate that `contains` carries a string, `equals` carries a non-null scalar, and null operators carry no value.
- [ ] Add session-manager methods that reject non-SQL sessions and serialize each operation through the existing queue.
- [ ] Store DDL plans in the owning session entry with the session owner, exact request, five-minute expiry, and one-use state.
- [ ] Reject apply when the plan is missing, expired, owned by another window, already consumed, or destructive without confirmation.
- [ ] Register each IPC operation through the existing trusted-sender helper and expose it through preload.
- [ ] Run `npm run typecheck` to check the new contract across main, preload, and renderer.

## Task 3: Add metadata and type catalogs for all SQL engines

**Files:**
- Modify: `src/main/connectors/mysql/mysql-adapter.ts`
- Modify: `src/main/connectors/postgres/postgres-adapter.ts`
- Modify: `src/main/connectors/sqlserver/sqlserver-adapter.ts`
- Modify: `src/main/connectors/oracle/oracle-adapter.ts`
- Modify: `src/main/connectors/sqlite/sqlite-adapter.ts`

**Steps:**

- [ ] Implement `describeTable` with engine metadata queries for column names, native type names, nullability, defaults, and ordered primary-key columns.
- [ ] Implement `listColumnTypes` with a fixed adapter-owned allowlist and argument rules for each engine.
- [ ] Use parameterized schema/table predicates for catalog queries. Quote only catalog-validated identifiers.
- [ ] For SQLite, resolve the selected database name to `main` or `temp` and use `PRAGMA table_info` on that exact database.
- [ ] Return a normalized unsupported-feature error when an engine cannot expose required primary-key metadata.
- [ ] Run `npm run typecheck` after all five `SqlSession` implementations have the new methods.

## Task 4: Add bounded table paging, sorting, and filters

**Files:**
- Modify: all five relational adapter files from Task 3
- Modify: `src/main/connectors/relational/row-normalizer.ts` only if a bounded page helper can serve every engine without weakening existing limits

**Steps:**

- [ ] Build each SELECT from the validated `TableIdentifier`, metadata-checked sort column, and metadata-checked filter columns.
- [ ] Bind every filter value through the driver's parameter API. Escape wildcard characters for `contains` before binding.
- [ ] Implement engine-specific pagination for MySQL/MariaDB, PostgreSQL, SQL Server, Oracle, and SQLite.
- [ ] Add the primary key as a deterministic tie-breaker when the user sort omits it. Keep reads available without a key and return the existing warning state to the UI.
- [ ] Fetch at most `limit + 1` rows, enforce cell and page-byte limits, and return `hasNext` without returning the extra row.
- [ ] Reject `contains` for non-text columns and normalize engine errors without including filter values.
- [ ] Run `npm run typecheck` after the five adapter implementations agree on `TablePage`.

## Task 5: Add table creation, column changes, and DDL previews

**Files:**
- Modify: all five relational adapter files from Task 3
- Modify: `src/main/connectors/database-session-manager.ts`

**Steps:**

- [ ] Generate `CREATE TABLE` statements from validated type catalog entries, typed defaults, nullability, and primary-key column names.
- [ ] Generate `ALTER TABLE` statements for add, rename, and drop column operations in each dialect.
- [ ] Mark rename and drop as destructive. Do not support existing type, nullability, default, or primary-key changes in this release.
- [ ] Capture the current table-definition fingerprint in each plan and recheck it before apply.
- [ ] Return the generated statements to the renderer as a preview. Store the executable plan in the owning session and consume it once after confirmation.
- [ ] Gate unsupported engine or server-version operations with a normalized error; do not silently fall back to a table rebuild.
- [ ] Run `npm run typecheck` after DDL plan signatures and session storage match.

## Task 6: Add primary-key row mutations

**Files:**
- Modify: all five relational adapter files from Task 3
- Modify: `src/main/connectors/database-session-manager.ts`

**Steps:**

- [ ] Build `INSERT` from metadata-validated columns and bound values; omit generated columns not present in the input.
- [ ] Build `UPDATE` from primary-key predicates, edited values, and null-safe `expectedValues` predicates.
- [ ] Build `DELETE` from primary-key predicates only. Leave confirmation to the renderer, where the selected row is visible.
- [ ] Validate composite keys in metadata order and reject writes when the supplied key does not match every primary-key column.
- [ ] Require one affected row for update/delete. Return a conflict when expected old values no longer match.
- [ ] Never retry writes. If completion is unknown, preserve the existing reconnect/reload behavior and ask the user to inspect the database before retrying.
- [ ] Run `npm run typecheck` after all driver result shapes map to `{ affectedRows }`.

## Task 7: Add SQL formatting and session history

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `docs/dependencies.md`
- Modify: `src/renderer/workspaces/sql/SqlWorkspace.tsx`

**Steps:**

- [ ] Install and pin `sql-formatter` 15.9.0 with `npm install --save-exact sql-formatter@15.9.0`.
- [ ] Record the package license, formatter purpose, and supported dialects in `docs/dependencies.md`.
- [ ] Select `mysql`, `postgresql`, `transactsql`, `plsql`, or `sqlite` from the active profile engine.
- [ ] Add a Format action that replaces SQL only after formatting succeeds and leaves the original text intact on errors.
- [ ] Add a session-only recent history list capped at 50 statements. Record each Run action newest-first, add a clear-history action, and reopen a selected statement in the editor.
- [ ] Confirm editor state and history clear when the workspace component unmounts.
- [ ] Run `npm run typecheck` after the formatter module is imported from the renderer bundle.

## Task 8: Add the table browser and designer UI

**Files:**
- Modify: `src/renderer/workspaces/sql/SqlWorkspace.tsx`
- Create: `src/renderer/workspaces/sql/TableBrowser.tsx`
- Create: `src/renderer/workspaces/sql/TableDesignerDialog.tsx`
- Create: `src/renderer/workspaces/sql/EditableTableGrid.tsx`
- Modify: `src/renderer/styles/database-workspaces.css`

**Steps:**

- [ ] Add an Open Table action for table objects. Keep views selectable only in the SQL editor.
- [ ] Add a table browser with page controls, column sort, equality/contains/null filters, and a visible page limit.
- [ ] Reset to offset zero when the selected table, sort, or filters change. Disable row writes when no primary key is present.
- [ ] Add create-table and alter-column forms that use `listColumnTypes`; do not accept free-form SQL type or default expressions.
- [ ] Show DDL statements before apply. Require a separate confirmation for a plan that renames or drops a column.
- [ ] Render row insert/edit forms. Confirm deletes and send primary-key maps plus expected old edited values.
- [ ] Show stale row conflicts and unknown mutation completion as reload-required states. Do not resubmit a mutation automatically.
- [ ] Add focused styles to `database-workspaces.css` and preserve the current connection, query, result, and CSV workflows.
- [ ] Run `npm run typecheck` after all renderer components consume the typed `DatabaseApi` methods.

## Task 9: Document the delivered SQL workflows

**Files:**
- Modify: `docs/user-guide.md`
- Modify: `docs/dependencies.md` if the final dependency entry changed during installation

**Steps:**

- [ ] Document SQL formatting and the 50-item session history.
- [ ] Document table paging, filters, sort behavior without a primary key, and the 200-row page cap.
- [ ] Document supported table changes, destructive confirmations, primary-key requirements, and unsupported type changes.
- [ ] Run `npm run typecheck` and `npm run build` as compile/build checks. Do not run the test suite.

## Implementation checkpoints

1. Complete Tasks 1-2 and typecheck before changing adapters.
2. Complete Tasks 3-4 and typecheck before adding schema writes.
3. Complete Tasks 5-6 and typecheck before connecting the UI.
4. Complete Tasks 7-9, then review the full diff and build once.
