# SQL editor and table tools implementation plan

> **For agentic workers:** The root owner implements shared contracts, IPC, and integrates work. Use a fresh worker in an isolated worktree for each independent task. Keep each unit on branch `codex/query-table-tools-impl` and do not add or run tests unless the user asks.

**Goal:** Add SQL formatting and session query history, paged table browsing, table design, and primary-key row editing for Aetherexa's five relational engines.

**Architecture:** Keep editor state in the renderer and database behavior in the main-process relational adapters. Add typed requests through `DatabaseApi`, preload IPC, validation, and `DatabaseSessionManager`. Group adapter operations under an optional `SqlSession.tables` capability; each of the five relational adapters supplies the complete capability.

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

- `src/shared/database.ts` owns serialized table request and result shapes.
- `src/shared/database-validation.ts` owns Zod bounds and request validation.
- `src/main/connectors/contracts.ts` owns the optional `SqlSession.tables` capability and the internal DDL plan type.
- `src/main/connectors/database-session-manager.ts` owns session/owner checks, operation serialization, and one-use DDL plans.
- `src/main/ipc/database-handlers.ts` owns validated IPC handlers for table operations.
- `src/preload/index.ts` exposes typed table operations without exposing Electron internals.
- Five relational adapter files own their engine's metadata queries, identifier quoting, pagination, DDL, and row operations.
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
- `TableFilter` is a union for `equals`, `contains`, `is-null`, and `is-not-null`.
- `TablePageRequest = { table: TableIdentifier; offset: number; limit: number; sort?: { column: string; direction: 'asc' | 'desc' }; filters: TableFilter[] }`
- `TablePage = { definition: TableDefinition; rows: WireValue[][]; offset: number; limit: number; hasNext: boolean }`
- `ColumnTypeOption = { name: string; label: string; argumentCount: number; minArgument: number; maxArgument: number }`
- `TableChange` is a union for `create`, `add-column`, `rename-column`, and `drop-column`.
- `NewTableColumn` carries a type name and numeric arguments, nullability, and a typed default (`none`, `literal`, or `current-timestamp`).
- `RowUpdate` carries primary-key values, old edited values, and new values.
- `SqlTableOperations` groups methods for metadata, pages, type options, DDL plans, and row mutations.
- `SqlSession.tables?: SqlTableOperations` keeps unsupported server versions representable without making SQL sessions invalid.

**Steps:**

- [ ] Add the shared table types beside `QueryPage` and retain `WireValue` for cells and filter values.
- [ ] Define `SqlTableOperations` with `describeTable`, `listColumnTypes`, `readTablePage`, `planTableChange`, `applyTableChange`, `insertRow`, `updateRow`, and `deleteRow`.
- [ ] Define the internal `SqlTableChangePlan` with exact statements, target table, destructive flag, and schema fingerprint.
- [ ] Add `tables?: SqlTableOperations` to `SqlSession`; do not require existing adapters to implement it yet.
- [ ] Run `npm run typecheck` to check the new types without changing current adapter behavior.

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

- [ ] Add strict Zod schemas for every request. Enforce global page, filter, offset, identifier, and collection-size limits.
- [ ] Validate that `contains` carries a string, `equals` carries a non-null scalar, and null operators carry no value.
- [ ] Add session-manager methods that reject non-SQL sessions and return `unsupported-feature` when `session.tables` is absent.
- [ ] Store DDL plans in the owning session entry with owner, exact request, five-minute expiry, and one-use state.
- [ ] Reject apply when the plan is missing, expired, owned by another window, already consumed, or destructive without confirmation.
- [ ] Register each IPC operation through the existing trusted-sender helper and expose it through preload.
- [ ] Run `npm run typecheck` to check the new API through main, preload, and renderer.

## Task 3: Implement MySQL and MariaDB table operations

**Files:**
- Modify: `src/main/connectors/mysql/mysql-adapter.ts`

**Steps:**

- [ ] Implement metadata from `INFORMATION_SCHEMA.COLUMNS` and primary-key order from `INFORMATION_SCHEMA.KEY_COLUMN_USAGE`, parameterized by schema and table.
- [ ] Return a fixed MySQL/MariaDB type catalog with numeric argument bounds.
- [ ] Implement page reads with `LIMIT` and `OFFSET`, `?` placeholders, `LIKE ... ESCAPE` for `contains`, and primary-key tie-breaking.
- [ ] Generate create/add/rename/drop DDL from validated identifiers and type catalog entries; return unsupported when the server version lacks a rename/drop form.
- [ ] Implement row inserts, optimistic updates using `<=>`-equivalent null-safe predicates, and key-targeted deletes with driver parameters.
- [ ] Return the complete `SqlSession.tables` capability and run `npm run typecheck`.

## Task 4: Implement PostgreSQL table operations

**Files:**
- Modify: `src/main/connectors/postgres/postgres-adapter.ts`

**Steps:**

- [ ] Implement metadata from `information_schema.columns` and ordered primary keys from `table_constraints` and `key_column_usage`.
- [ ] Return a fixed PostgreSQL type catalog with numeric argument bounds.
- [ ] Implement page reads with `LIMIT` and `OFFSET`, numbered parameters, `LIKE ... ESCAPE` for `contains`, and primary-key tie-breaking.
- [ ] Generate create/add/rename/drop statements with validated identifiers and typed defaults. Store a fingerprint of the live table definition in the DDL plan.
- [ ] Implement insert/update/delete with bound values and `IS NOT DISTINCT FROM` predicates for stale-edit checks.
- [ ] Return the complete `SqlSession.tables` capability and run `npm run typecheck`.

## Task 5: Implement SQL Server table operations

**Files:**
- Modify: `src/main/connectors/sqlserver/sqlserver-adapter.ts`

**Steps:**

- [ ] Implement metadata from `sys.schemas`, `sys.tables`, `sys.columns`, `sys.types`, and ordered primary-key index columns.
- [ ] Return a fixed SQL Server type catalog with numeric argument bounds.
- [ ] Implement page reads with `OFFSET ... FETCH NEXT`, bound parameters, escaped `LIKE` patterns, and primary-key tie-breaking.
- [ ] Generate create/add/rename/drop statements with bracket-quoted identifiers. Mark rename/drop plans destructive.
- [ ] Implement insert/update/delete with bound values and null-safe expected-value predicates.
- [ ] Return the complete `SqlSession.tables` capability and run `npm run typecheck`.

## Task 6: Implement Oracle table operations

**Files:**
- Modify: `src/main/connectors/oracle/oracle-adapter.ts`

**Steps:**

- [ ] Implement metadata from `ALL_TAB_COLUMNS`, `ALL_CONSTRAINTS`, and `ALL_CONS_COLUMNS`, ordered by primary-key position.
- [ ] Return a fixed Oracle type catalog with numeric argument bounds.
- [ ] Implement page reads with Oracle offset/fetch syntax, named bind variables, escaped `LIKE` patterns, and primary-key tie-breaking.
- [ ] Generate create/add/rename/drop statements with validated identifiers and typed defaults; return unsupported if the connected server version lacks offset/fetch.
- [ ] Implement insert/update/delete with bound values and null-safe expected-value predicates.
- [ ] Return the complete `SqlSession.tables` capability and run `npm run typecheck`.

## Task 7: Implement SQLite table operations

**Files:**
- Modify: `src/main/connectors/sqlite/sqlite-adapter.ts`

**Steps:**

- [ ] Implement metadata with `PRAGMA table_info` for the selected `main` or `temp` database.
- [ ] Return a fixed SQLite type catalog with numeric argument bounds.
- [ ] Implement page reads with `LIMIT` and `OFFSET`, bound values, escaped `LIKE` patterns, and primary-key tie-breaking.
- [ ] Generate create/add/rename/drop statements for SQLite. Read `sqlite_version()` and return unsupported if the version lacks a requested alter form.
- [ ] Implement insert/update/delete with bound values and `IS` comparisons for stale-edit checks.
- [ ] Return the complete `SqlSession.tables` capability and run `npm run typecheck`.

## Task 8: Add SQL formatting and session history

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
- [ ] Add a session-only recent history list capped at 50 statements. Record Run actions newest-first and add clear/reopen controls.
- [ ] Confirm editor text and history clear when the workspace component unmounts.
- [ ] Run `npm run typecheck` after the formatter module is imported from the renderer bundle.

## Task 9: Add the table browser and designer UI

**Files:**
- Modify: `src/renderer/workspaces/sql/SqlWorkspace.tsx`
- Create: `src/renderer/workspaces/sql/TableBrowser.tsx`
- Create: `src/renderer/workspaces/sql/TableDesignerDialog.tsx`
- Create: `src/renderer/workspaces/sql/EditableTableGrid.tsx`
- Modify: `src/renderer/styles/database-workspaces.css`

**Steps:**

- [ ] Add an Open Table action for table objects. Keep views selectable only in the SQL editor.
- [ ] Add table page controls, column sort, equality/contains/null filters, and a visible page limit.
- [ ] Reset the offset when the selected table, sort, or filters change. Disable row writes when no primary key is present.
- [ ] Add create-table and alter-column forms that use `listColumnTypes`; reject free-form SQL type or default expressions.
- [ ] Show DDL statements before apply. Require a separate confirmation for a plan that renames or drops a column.
- [ ] Render row insert/edit forms. Confirm deletes and send primary-key maps plus expected old edited values.
- [ ] Show stale row conflicts and unknown mutation completion as reload-required states. Do not resubmit a mutation automatically.
- [ ] Add focused styles and preserve the current connection, query, result, and CSV workflows.
- [ ] Run `npm run typecheck` after all renderer components consume the typed `DatabaseApi` methods.

## Task 10: Document the delivered SQL workflows

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
2. Complete Tasks 3-5 and typecheck before adding later adapters.
3. Complete Tasks 6-7 and typecheck before connecting the UI.
4. Complete Tasks 8-10, then review the full diff and build once.
