import { useEffect, useMemo, useRef, useState } from 'react';
import { format, type SqlLanguage } from 'sql-formatter';
import type { DatabaseEngine, DatabaseProfile } from '@shared/profiles';
import type { Namespace, QueryPage, DatabaseObject, TableDefinition, TableIdentifier } from '@shared/database';
import { TableBrowser } from './TableBrowser.js';
import { TableDesignerDialog } from './TableDesignerDialog.js';
import { engineLabel } from '@renderer/components/ConnectionSidebar.js';
import { useDatabaseSession } from '@renderer/state/database-sessions.js';

type QueryTab = { id: string; sql: string; page: QueryPage | null; operationId: string | null; error: string };
type WorkspaceView = { kind: 'objects' } | { kind: 'query'; queryId: string } | { kind: 'table'; table: TableIdentifier };

export function SqlWorkspace({ profile }: { profile: DatabaseProfile }) {
  const { state, reconnect } = useDatabaseSession(profile.id);
  const [namespaces, setNamespaces] = useState<Namespace[]>([]);
  const [objects, setObjects] = useState<DatabaseObject[]>([]);
  const [namespace, setNamespace] = useState('');
  const [queries, setQueries] = useState<QueryTab[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [view, setView] = useState<WorkspaceView>({ kind: 'objects' });
  const [designer, setDesigner] = useState<{ namespace: string; definition?: TableDefinition } | null>(null);
  const [objectRefresh, setObjectRefresh] = useState(0);
  const [error, setError] = useState('');
  const cancelledOperations = useRef(new Set<string>());
  const objectRequest = useRef(0);
  const activeQuery = view.kind === 'query' ? queries.find((item) => item.id === view.queryId) ?? null : null;
  const page = activeQuery?.page ?? null;

  useEffect(() => {
    if (state.phase !== 'ready') return;
    void window.productivityApi.database.listNamespaces({ sessionId: state.session.sessionId }).then((result) => {
      if (!result.ok) { setError(result.error.message); return; }
      setNamespaces(result.value);
      setNamespace((current) => current || result.value[0]?.name || '');
    });
  }, [state]);
  useEffect(() => {
    if (state.phase !== 'ready' || !namespace) return;
    const requestId = ++objectRequest.current;
    void window.productivityApi.database.listObjects({ sessionId: state.session.sessionId, namespace }).then((result) => {
      if (requestId !== objectRequest.current) return;
      if (result.ok) setObjects(result.value); else setError(result.error.message);
    });
    return () => { objectRequest.current++; };
  }, [state, namespace, objectRefresh]);

  async function runQuery(queryId: string) {
    const query = queries.find((item) => item.id === queryId);
    if (state.phase !== 'ready' || !query?.sql.trim() || query.operationId) return;
    const operationId = crypto.randomUUID();
    setHistory((current) => [query.sql, ...current].slice(0, 50));
    setQueries((current) => current.map((item) => item.id === queryId ? { ...item, operationId, error: '' } : item));
    const result = await window.productivityApi.database.runSql({ sessionId: state.session.sessionId, operationId, sql: query.sql, limit: 10_000 });
    if (cancelledOperations.current.delete(operationId)) return;
    setQueries((current) => current.map((item) => item.id === queryId ? { ...item, operationId: null, page: result.ok ? result.value : item.page, error: result.ok ? '' : result.error.message } : item));
    if (!result.ok && result.error.code === 'completion-unknown') reconnect();
  }
  function formatQuery(queryId: string) {
    const query = queries.find((item) => item.id === queryId);
    const language = formatterLanguage[profile.engine];
    if (!language || !query?.sql.trim()) return;
    try { const formatted = format(query.sql, { language }); setQueries((current) => current.map((item) => item.id === queryId ? { ...item, sql: formatted, error: '' } : item)); }
    catch { setQueries((current) => current.map((item) => item.id === queryId ? { ...item, error: 'Could not format this SQL. Check the statement and try again.' } : item)); }
  }
  function openQuery(sql = 'SELECT 1') {
    const query: QueryTab = { id: crypto.randomUUID(), sql, page: null, operationId: null, error: '' };
    setQueries((current) => [...current, query]); setView({ kind: 'query', queryId: query.id }); setError('');
  }
  function closeQuery(queryId: string) {
    if (queries.find((item) => item.id === queryId)?.operationId) return;
    setQueries((current) => current.filter((item) => item.id !== queryId));
    if (view.kind === 'query' && view.queryId === queryId) setView({ kind: 'objects' });
  }
  function selectObject(item: DatabaseObject) {
    openQuery('SELECT * FROM ' + objectReference(profile, namespace, item.name) + ';');
  }
  function openTable(name: string) {
    setView({ kind: 'table', table: { namespace, name } });
  }
  async function cancelQuery(queryId: string) {
    const query = queries.find((item) => item.id === queryId);
    if (state.phase !== 'ready' || !query?.operationId) return;
    const operationId = query.operationId;
    cancelledOperations.current.add(operationId);
    const result = await window.productivityApi.database.cancel({ sessionId: state.session.sessionId, operationId });
    if (!result.ok && result.error.code === 'completion-unknown') {
      setQueries((current) => current.map((item) => item.id === queryId ? { ...item, page: null, operationId: null, error: result.error.message } : item));
      reconnect();
    } else if (!result.ok && result.error.code === 'operation-not-running') { cancelledOperations.current.delete(operationId); setQueries((current) => current.map((item) => item.id === queryId ? { ...item, operationId: null } : item)); }
    else if (!result.ok) setQueries((current) => current.map((item) => item.id === queryId ? { ...item, operationId: null, error: result.error.message } : item));
    else setQueries((current) => current.map((item) => item.id === queryId && item.operationId === operationId ? { ...item, operationId: null } : item));
  }
  const csv = useMemo(() => page ? createCsv(page) : '', [page]);
  const downloadCsv = () => {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = profile.name.replace(/[^a-z0-9-_]/gi, '_') + '-results.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="database-workspace">
      <header className="db-workspace-header">
        <div><p className="eyebrow">{engineLabel(profile.engine)} workspace</p><h1>{profile.name}</h1><span>{profile.engine === 'sqlite' ? String(profile.options.path ?? '') : String(profile.options.host ?? '')}</span></div>
        <div className="connection-state">{state.phase === 'connecting' ? 'Connecting…' : state.phase === 'ready' ? <><i /> Connected</> : <button onClick={reconnect}>Reconnect</button>}</div>
      </header>
      {error && <div className="workspace-error" role="alert">{error}</div>}
      {state.phase === 'error' ? (
        <div className="connect-empty"><strong>Connection failed</strong><p>{state.error.message}</p><button className="button button-secondary" onClick={reconnect}>Try again</button></div>
      ) : state.phase === 'connecting' ? (
        <div className="connect-empty">Opening a protected connection…</div>
      ) : (
        <div className="sql-layout">
          <aside className="object-tree">
            <div className="workspace-panel-title">OBJECTS</div>
            <label className="namespace-select"><span>Schema</span><select value={namespace} onChange={(event) => { objectRequest.current++; setObjects([]); setNamespace(event.target.value); setView({ kind: 'objects' }); }}>{namespaces.map((item, index) => <option key={item.databaseName + item.name + index} value={item.name}>{item.name}</option>)}</select></label>
            <button className="button button-subtle button-small" disabled={!namespace} onClick={() => setDesigner({ namespace })}>Create table</button>
            <div className="object-list">{objects.map((item) => <div className="table-object" key={item.name}><button onClick={() => selectObject(item)}><span>{item.kind === 'view' ? '◉' : '▦'}</span>{item.name}</button>{item.kind === 'table' && <button aria-label={`Open table ${item.name}`} onClick={() => openTable(item.name)}>Open</button>}</div>)}</div>
            <div className="data-toolbar"><div className="workspace-panel-title">QUERY HISTORY</div><button className="button button-subtle button-small" onClick={() => setHistory([])} disabled={!history.length}>Clear</button></div>
            <div className="object-list" aria-label="Recent queries">{history.map((query, index) => <button key={index} title={query} onClick={() => openQuery(query)}>{query.replace(/\s+/g, ' ').trim()}</button>)}</div>
          </aside>
          <div className="sql-main">
            <nav className="sql-workspace-tabs" aria-label="Database views">
              <button className={view.kind === 'objects' ? 'selected' : ''} onClick={() => setView({ kind: 'objects' })}>Objects</button>
              {queries.map((query, index) => <button key={query.id} className={view.kind === 'query' && view.queryId === query.id ? 'selected' : ''} onClick={() => setView({ kind: 'query', queryId: query.id })}>Query {index + 1}{!query.operationId && <span className="sql-tab-close" role="button" tabIndex={0} aria-label={`Close query ${index + 1}`} onClick={(event) => { event.stopPropagation(); closeQuery(query.id); }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); closeQuery(query.id); } }}>×</span>}</button>)}
              {view.kind === 'table' && <button className="selected">{view.table.name}</button>}
              <button className="button button-primary button-small sql-new-query" onClick={() => openQuery()}>＋ New query</button>
            </nav>
            {view.kind === 'objects' && <section className="sql-object-browser"><div className="sql-object-heading"><div><span>DATABASE OBJECTS</span><h2>{namespace || 'Choose a schema'}</h2></div><button className="button button-primary button-small" onClick={() => openQuery()}>New query</button></div>
              {objects.length ? <div className="sql-object-catalog">{objects.map((item) => <div className="sql-object-card" key={item.name}><button className="sql-object-name" onClick={() => item.kind === 'table' ? openTable(item.name) : selectObject(item)}><span>{item.kind === 'view' ? '◉' : '▦'}</span><strong>{item.name}</strong></button><small>{item.kind}</small><button className="button button-subtle button-small" onClick={() => item.kind === 'table' ? openTable(item.name) : selectObject(item)}>{item.kind === 'table' ? 'Open table' : 'Open query'}</button></div>)}</div> : <div className="results-empty">No objects in this schema yet. Open a query to get started.</div>}
            </section>}
            {view.kind === 'query' && activeQuery && <>
              <div className="sql-editor-heading"><span>SQL Editor</span><div className="data-toolbar" style={{ marginLeft: 'auto' }}><button className="button button-subtle button-small" onClick={() => formatQuery(activeQuery.id)} disabled={!activeQuery.sql.trim()}>Format</button>{activeQuery.operationId ? <button className="button button-subtle" onClick={() => void cancelQuery(activeQuery.id)}>Cancel query</button> : <button className="button button-primary button-small" onClick={() => void runQuery(activeQuery.id)}>Run query</button>}</div></div>
              <textarea className="sql-editor" spellCheck={false} aria-label="SQL query editor" value={activeQuery.sql} disabled={Boolean(activeQuery.operationId)} onChange={(event) => setQueries((current) => current.map((item) => item.id === activeQuery.id ? { ...item, sql: event.target.value, error: '' } : item))} />
              {activeQuery.error && <div className="workspace-error" role="alert">{activeQuery.error}</div>}
              <div className="results-heading"><span>Results</span>{page && <><small>{page.rows.length.toLocaleString()} rows{page.truncated ? ' · output capped at ' + (page.truncationReason ?? 'limit') : ''}</small><button className="button button-subtle button-small" onClick={downloadCsv}>Export CSV</button></>}</div>
              {page ? <ResultsGrid page={page} /> : <div className="results-empty">Run a query to view results.</div>}
            </>}
            {view.kind === 'table' && <TableBrowser key={JSON.stringify([state.session.sessionId, view.table.namespace, view.table.name, objectRefresh])} sessionId={state.session.sessionId} table={view.table} refreshToken={objectRefresh} onDesign={(definition) => setDesigner({ namespace: definition.table.namespace, definition })} />}
          </div>
        </div>
      )}
      {state.phase === 'ready' && designer && <TableDesignerDialog key={JSON.stringify([state.session.sessionId, designer.namespace, designer.definition?.table.name ?? null])} sessionId={state.session.sessionId} namespace={designer.namespace} definition={designer.definition} onClose={() => setDesigner(null)} onApplied={(table) => { objectRequest.current++; setObjects([]); setDesigner(null); setNamespace(table.namespace); setView({ kind: 'table', table }); setObjectRefresh((value) => value + 1); }} />}
    </section>
  );
}

const formatterLanguage: Partial<Record<DatabaseEngine, SqlLanguage>> = { mysql: 'mysql', postgres: 'postgresql', sqlserver: 'transactsql', oracle: 'plsql', sqlite: 'sqlite' };

function ResultsGrid({ page }: { page: QueryPage }) {
  const visible = page.rows.slice(0, 300);
  return <div className="results-grid-wrap"><table className="results-grid"><thead><tr><th>#</th>{page.columns.map((column, index) => <th key={column.name + index}><span>{column.name}</span><small>{column.typeHint}</small></th>)}</tr></thead><tbody>{visible.map((row, index) => <tr key={index}><td>{index + 1}</td>{row.map((value, cell) => <td key={cell}>{formatCell(value)}</td>)}</tr>)}</tbody></table>{page.rows.length > visible.length && <div className="results-note">Showing the first 300 rows. CSV export includes the full result page.</div>}</div>;
}
function formatCell(value: unknown): string { if (value === null) return 'NULL'; if (value instanceof Uint8Array) return '[binary ' + value.byteLength + ' bytes]'; return typeof value === 'object' ? JSON.stringify(value) : String(value); }
function objectReference(profile: DatabaseProfile, namespace: string, name: string): string {
  const quote = profile.engine === 'mysql' ? (value: string) => '`' + value.replaceAll('`', '``') + '`' : profile.engine === 'sqlserver' ? (value: string) => '[' + value.replaceAll(']', ']]') + ']' : (value: string) => '"' + value.replaceAll('"', '""') + '"';
  return [namespace, name].map(quote).join('.');
}
function createCsv(page: QueryPage): string { const field = (value: unknown) => '"' + formatCell(value).replaceAll('"', '""') + '"'; return [page.columns.map((column) => field(column.name)).join(','), ...page.rows.map((row) => row.map(field).join(','))].join('\r\n'); }

