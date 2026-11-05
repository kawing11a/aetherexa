import { useEffect, useRef, useState } from 'react';
import type { TableDefinition, TableFilter, TableIdentifier, TablePage, WireValue } from '@shared/database';
import { EditableTableGrid } from './EditableTableGrid.js';

type Props = { sessionId: string; table: TableIdentifier; refreshToken: number; onDesign(definition: TableDefinition): void };
type Operator = 'equals' | 'contains' | 'is-null' | 'is-not-null';
type FilterKind = 'text' | 'number' | 'boolean';

function filterValue(value: string, kind: FilterKind): WireValue {
  if (kind === 'text') return value;
  if (kind === 'boolean') return value === 'true';
  if (!value.trim()) throw new Error('Enter a filter value.');
  const significant = value.replace(/^[+-]/, '').split(/[eE]/)[0].replace('.', '').replace(/^0+|0+$/g, '');
  if (significant.length > 15 && /[.eE]/.test(value)) throw new Error('Use text to preserve this exact decimal.');
  const parsed = Number(value);
  if (parsed === 0 && significant.length > 0) throw new Error('This number is too small to represent. Use text to preserve it.');
  if (!Number.isFinite(parsed) || Number.isInteger(parsed) && !Number.isSafeInteger(parsed)) throw new Error('Use a finite number within the safe integer range, or use text for an exact decimal.');
  return parsed;
}

export function TableBrowser({ sessionId, table, refreshToken, onDesign }: Props) {
  const [page, setPage] = useState<TablePage | null>(null);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(50);
  const [sort, setSort] = useState<{ column: string; direction: 'asc' | 'desc' }>();
  const [filters, setFilters] = useState<TableFilter[]>([]);
  const [filterColumn, setFilterColumn] = useState('');
  const [operator, setOperator] = useState<Operator>('equals');
  const [filterKind, setFilterKind] = useState<FilterKind>('text');
  const [filterText, setFilterText] = useState('');
  const [reload, setReload] = useState(0);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pageFailed, setPageFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(0);
  const invalidate = () => { requestId.current++; setLoading(true); };

  useEffect(() => {
    if (reloadRequired) return;
    const id = ++requestId.current;
    setLoading(true); setError('');
    void window.productivityApi.database.readTablePage({ sessionId, request: { table, offset, limit, sort, filters } }).then((result) => {
      if (requestId.current !== id) return;
      setLoading(false);
      if (result.ok) { setPageFailed(false); setPage(result.value); setRevision((value) => value + 1); setFilterColumn((value) => result.value.definition.columns.some((column) => column.name === value) ? value : result.value.definition.columns[0]?.name || ''); }
      else { setPageFailed(true); setError(result.error.message); }
    }).catch(() => { if (requestId.current === id) { setLoading(false); setPageFailed(true); setError('The table page could not be loaded.'); } });
    return () => { requestId.current++; };
  }, [sessionId, table.namespace, table.name, offset, limit, sort, filters, reload, refreshToken, reloadRequired]);

  function changeSort(column: string) {
    invalidate(); setOffset(0); setSort(column ? { column, direction: 'asc' } : undefined);
  }
  function addFilter() {
    if (!filterColumn || filters.length >= 10) return;
    try {
      const next: TableFilter = operator === 'is-null' || operator === 'is-not-null'
        ? { column: filterColumn, operator }
        : { column: filterColumn, operator, value: operator === 'contains' ? filterText : filterValue(filterText, filterKind) };
      invalidate(); setOffset(0); setFilters((items) => [...items, next]); setError('');
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Invalid filter.'); }
  }
  function reloadPage() { invalidate(); setReloadRequired(false); setReload((value) => value + 1); }
  const locked = loading || busy || reloadRequired;
  return <section className="table-browser" aria-label={`Table ${table.namespace}.${table.name}`}>
    <div className="table-meta-rail"><div><small>Table</small><strong>{table.namespace} <span>/</span> {table.name}</strong></div><div><small>Page</small><strong>{page ? `${page.offset + (page.rows.length ? 1 : 0)}–${page.offset + page.rows.length}` : '—'} <span>·</span> limit {limit}</strong></div><button className="button button-subtle button-small" disabled={busy} onClick={reloadPage}>Reload</button><button className="button button-secondary button-small" disabled={busy || loading || reloadRequired || pageFailed || !page} onClick={() => { if (page) onDesign(page.definition); }}>Design table</button></div>
    {error && <div className="workspace-error" role="alert">{error}</div>}
    {reloadRequired && <div className="workspace-error" role="alert">The row state may have changed. Reload the table before editing again.</div>}
    <div className="data-toolbar table-controls"><label>Rows per page <select value={limit} disabled={locked} onChange={(event) => { invalidate(); setOffset(0); setLimit(Number(event.target.value)); }}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option><option value={200}>200</option></select></label>
      <label>Sort <select value={sort?.column ?? ''} disabled={locked || !page} onChange={(event) => changeSort(event.target.value)}><option value="">Default</option>{page?.definition.columns.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
      <button className="button button-subtle button-small" disabled={locked || !sort} onClick={() => { invalidate(); setOffset(0); setSort((value) => value && ({ ...value, direction: value.direction === 'asc' ? 'desc' : 'asc' })); }}>{sort?.direction === 'desc' ? 'Descending' : 'Ascending'}</button>
      <button className="button button-subtle button-small" disabled={locked || pageFailed || offset === 0} onClick={() => { invalidate(); setOffset(Math.max(0, offset - limit)); }}>Previous</button><button className="button button-subtle button-small" disabled={locked || pageFailed || !page?.hasNext || offset + limit > 2_147_483_647} onClick={() => { invalidate(); setOffset(offset + limit); }}>Next</button>
    </div>
    {page && <div className="table-filter-panel"><div className="data-toolbar"><label>Column <select value={filterColumn} disabled={locked} onChange={(event) => setFilterColumn(event.target.value)}>{page.definition.columns.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label><label>Filter <select value={operator} disabled={locked} onChange={(event) => setOperator(event.target.value as Operator)}><option value="equals">Equals</option><option value="contains">Contains</option><option value="is-null">Is NULL</option><option value="is-not-null">Is not NULL</option></select></label>
      {(operator === 'equals' || operator === 'contains') && <>{operator === 'equals' && <select aria-label="Filter value type" value={filterKind} disabled={locked} onChange={(event) => { setFilterKind(event.target.value as FilterKind); setFilterText(event.target.value === 'boolean' ? 'true' : ''); }}><option value="text">Text</option><option value="number">Number</option><option value="boolean">Boolean</option></select>}{operator === 'equals' && filterKind === 'boolean' ? <select aria-label="Filter value" value={filterText} disabled={locked} onChange={(event) => setFilterText(event.target.value)}><option value="true">true</option><option value="false">false</option></select> : <input aria-label="Filter value" value={filterText} disabled={locked} onChange={(event) => setFilterText(event.target.value)} />}</>}
      <button className="button button-secondary button-small" disabled={locked || !filterColumn || filters.length >= 10} onClick={addFilter}>Add filter</button></div>
      {filters.length > 0 && <div className="table-filter-list">{filters.map((filter, index) => <button className="button button-subtle button-small" key={index} disabled={locked} title="Remove filter" onClick={() => { invalidate(); setOffset(0); setFilters((items) => items.filter((_, i) => i !== index)); }}>{filter.column} · {filter.operator}{'value' in filter ? ' · ' + String(filter.value) : ''} ×</button>)}</div>}</div>}
    {loading && <p className="workspace-hint" role="status">Loading table page…</p>}
    {page && <EditableTableGrid key={revision} sessionId={sessionId} page={page} disabled={locked || pageFailed} onBusyChange={setBusy} onChanged={reloadPage} onReloadRequired={(message) => { requestId.current++; setReloadRequired(true); setError(message); }} />}
    {!page && !loading && !error && <div className="results-empty">Choose a table to view its rows.</div>}
  </section>;
}
