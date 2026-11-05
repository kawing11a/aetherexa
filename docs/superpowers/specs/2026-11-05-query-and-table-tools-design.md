# SQL editor and table tools design

## Goal

Add three SQL workspace workflows to Aetherexa: SQL formatting and recent query history, a paged table browser, and table design and row editing. Support MySQL/MariaDB, PostgreSQL, SQL Server, Oracle, and SQLite through the existing relational connector boundary.

The renderer owns editor and browser state. The main process owns database metadata, SQL generation, bound values, and mutations. No database driver or connection object crosses IPC.

## Usage

- Format the current SQL statement with the dialect for its connection.
- Reopen one of the 50 most recent statements from the current SQL workspace session.
- Open a table from the object list, then page through rows, sort by a column, or add a supported filter.
- Inspect a table's columns, types, nullability, defaults, and primary key.
- Create a table or alter its columns. Review generated SQL before applying destructive changes.
- Insert, update, and delete rows. Update and delete use the table's primary key. Read-only mode applies when the adapter cannot identify one.

The formatter uses `sql-formatter` 15.9.0 with the connection's dialect. The library supports MariaDB/MySQL, PostgreSQL, Transact-SQL, Oracle PL/SQL, and SQLite. See the [formatter dialect list](https://github.com/sql-formatter-org/sql-formatter/blob/master/docs/dialect.md) and [15.9.0 release notes](https://github.com/sql-formatter-org/sql-formatter/releases/tag/v15.9.0).

## Data shapes

```ts
type TableIdentifier = { namespace: string; name: string };

type TableColumn = {
  name: string;
  typeName: string;
  nullable: boolean;
  defaultExpression: string | null;
  primaryKeyOrder: number | null;
};

type TableDefinition = {
  table: TableIdentifier;
  columns: TableColumn[];
};

type TableFilter =
  | { column: string; operator: 'equals' | 'contains'; value: WireValue }
  | { column: string; operator: 'is-null' | 'is-not-null' };

type TablePageRequest = {
  table: TableIdentifier;
  offset: number;
  limit: number;
  sort?: { column: string; direction: 'asc' | 'desc' };
  filters: TableFilter[];
};

type TablePage = {
  definition: TableDefinition;
  rows: WireValue[][];
  offset: number;
  limit: number;
  hasNext: boolean;
};

type TableChange =
  | { kind: 'create'; table: TableIdentifier; columns: NewTableColumn[]; primaryKey: string[] }
  | { kind: 'add-column'; table: TableIdentifier; column: NewTableColumn }
  | { kind: 'rename-column'; table: TableIdentifier; from: string; to: string }
  | { kind: 'drop-column'; table: TableIdentifier; column: string };

type TableChangePreview = { planId: string; statements: string[]; destructive: boolean };
type ApplyTableChange = { planId: string; confirmDestructive: boolean };

type NewTableColumn = {
  name: string;
  type: { name: string; arguments: number[] };
  nullable: boolean;
  default: { kind: 'none' } | { kind: 'literal'; value: WireValue } | { kind: 'current-timestamp' };
};

type RowInsert = { table: TableIdentifier; values: Record<string, WireValue> };
type RowUpdate = { table: TableIdentifier; key: Record<string, WireValue>; expectedValues: Record<string, WireValue>; values: Record<string, WireValue> };
type RowDelete = { table: TableIdentifier; key: Record<string, WireValue> };
```

Each adapter owns an allowlist of type names and argument rules. The renderer selects only types from that list. Defaults are typed literals or `CURRENT_TIMESTAMP`; free-form SQL expressions are out of scope. This keeps table definitions out of raw SQL concatenation.

`equals` accepts a non-null scalar value. Use `is-null` or `is-not-null` for null checks. Row edits accept scalar values supported by the selected column's driver type; adapters reject unsupported values.

`RowUpdate.expectedValues` contains the old values for the edited columns. The adapter uses them in a null-safe predicate with the primary key. It rejects the update as stale if another write changed an edited column after the page loaded.

The server returns one extra row internally to determine `hasNext`; it does not send that row to the renderer. The page size is at most 200 rows, the offset is at most 2,147,483,647, and a request has at most 10 filters. Text filter values are at most 4 KiB. Filters and sort columns must match the live table definition. `contains` accepts text columns only. Values use the existing serializable `WireValue` union.

## Architecture

Add table operations to `DatabaseApi`, `SqlSession`, the shared request schemas, and the database IPC handlers. Operations cover table metadata, a bounded page read, supported column types, a DDL preview and apply pair, and row insert/update/delete. `DatabaseSessionManager` continues to validate session ownership and serialize operations. Each relational adapter implements its engine's metadata queries, identifier quoting, pagination, DDL, and row operations.

The renderer sends typed requests. It does not construct SQL for table paging or row changes. Adapters quote identifiers after validating them against metadata and bind filter and row values through driver parameters. Adapters return `TableDefinition` and bounded `TablePage` values, not driver objects. A DDL preview returns a plan ID that expires after five minutes and belongs to one session owner and exact change request. Apply consumes that plan once and requires destructive confirmation when the plan drops or renames a column.

The SQL workspace keeps query text and recent history in renderer memory for the life of the workspace. It does not persist query text across app restarts. Formatting replaces the current query only when the selected formatter succeeds; on a parse failure, the editor keeps its original text and shows the formatter error.

The table browser keeps one selected table, page offset, page size, optional sort, and filters. Changing the table, sort, or filters resets the offset to zero. The adapter uses the primary key as a stable tie-breaker when one exists. Without a primary key, browsing remains available, but writes are disabled and the UI states that page order may shift.

Table definition changes are previewed before apply. Dropping or renaming a column requires an explicit confirmation. Table creation and adding a column do not require a destructive-change confirmation. Row updates use only the declared primary key. Deletes require confirmation. Mutations report affected-row counts and are never retried automatically.

## Errors and limits

- Reject invalid identifiers, oversized filters, invalid page limits, and unsupported operators at the IPC boundary.
- Reject sort/filter fields that are absent from the current table definition. `contains` is valid only for text columns.
- Return a normalized unsupported-operation error when an engine or server version cannot perform a requested schema operation.
- Preserve existing result row, cell, and page byte limits. Table pages have a smaller fixed row limit.
- If a mutation returns an unknown completion result, clear the pending editor state and ask the user to reload the table before retrying.
- A missing primary key disables row writes. A read-only connection or insufficient database privilege returns an operation error without changing editor state.

## Verification

- Check that the formatter selects the right dialect for each relational engine and leaves SQL unchanged when formatting fails.
- Check query history ordering, the 50-entry bound, and clearing history when the workspace closes.
- Check table metadata and page boundaries on each relational engine, including composite keys and quoted identifiers.
- Check filter parameter binding, sort validation, and result limits.
- Check table create/add/rename/drop previews and apply behavior. Verify that a plan is session-owned, expires, and can be applied once. Verify that destructive confirmation blocks a drop when declined.
- Check insert/update/delete targeting, including composite primary keys, stale edits, and tables without primary keys.
- Run the project's typecheck and build after implementation. Exercise the new workflows against disposable databases for all supported engines; do not use saved user connections or databases for verification.

## Not in scope

This change does not add database backups, BI reports, visual data modeling, SQL autocomplete, query tabs, saved-query files, view editing, stored procedure editing, bulk row operations, MongoDB writes, or Redis and Memcached table views.

The table designer does not change an existing column's type, nullability, or default. It does not change a table's primary key after creation.
