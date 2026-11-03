import { useEffect, useMemo, useRef, useState } from 'react';
import type { DatabaseProfile } from '@shared/profiles';
import type { Namespace, QueryPage, DatabaseObject } from '@shared/database';
import { engineLabel } from '@renderer/components/ConnectionSidebar.js';
import { useDatabaseSession } from '@renderer/state/database-sessions.js';

export function SqlWorkspace({ profile }: { profile: DatabaseProfile }) {
  const { state, reconnect } = useDatabaseSession(profile.id);
  const [namespaces, setNamespaces] = useState<Namespace[]>([]);
  const [objects, setObjects] = useState<DatabaseObject[]>([]);
  const [namespace, setNamespace] = useState('');
  const [sql, setSql] = useState('SELECT 1');
  const [page, setPage] = useState<QueryPage | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState<string | null>(null);
  const cancelledOperations = useRef(new Set<string>());

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
    void window.productivityApi.database.listObjects({ sessionId: state.session.sessionId, namespace }).then((result) => {
      if (result.ok) setObjects(result.value); else setError(result.error.message);
    });
  }, [state, namespace]);

  async function runQuery() {
    if (state.phase !== 'ready' || !sql.trim()) return;
    const operationId = crypto.randomUUID();
    setRunning(operationId); setError('');
    const result = await window.productivityApi.database.runSql({ sessionId: state.session.sessionId, operationId, sql, limit: 10_000 });
    if (cancelledOperations.current.delete(operationId)) return;
    if (result.ok) setPage(result.value); else { setError(result.error.message); if (result.error.code === 'completion-unknown') reconnect(); }
    setRunning((current) => current === operationId ? null : current);
  }
  async function cancelQuery() {
    if (state.phase !== 'ready' || !running) return;
    const operationId = running;
    const result = await window.productivityApi.database.cancel({ sessionId: state.session.sessionId, operationId });
    setRunning((current) => current === operationId ? null : current);
    if (!result.ok && result.error.code === 'completion-unknown') {
      cancelledOperations.current.add(operationId);
      setPage(null);
      setError(result.error.message);
      reconnect();
    } else if (!result.ok && result.error.code !== 'operation-not-running') setError(result.error.message);
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
            <label className="namespace-select"><span>Schema</span><select value={namespace} onChange={(event) => setNamespace(event.target.value)}>{namespaces.map((item, index) => <option key={item.databaseName + item.name + index} value={item.name}>{item.name}</option>)}</select></label>
            <div className="object-list">{objects.map((item) => <button key={item.name} onClick={() => setSql((text) => text + (text.endsWith('\n') ? '' : '\n') + 'SELECT * FROM ' + objectReference(profile, namespace, item.name) + ';')}><span>{item.kind === 'view' ? '◉' : '▦'}</span>{item.name}</button>)}</div>
          </aside>
          <div className="sql-main">
            <div className="sql-editor-heading"><span>SQL Editor</span>{running ? <button className="button button-subtle" onClick={() => void cancelQuery()}>Cancel</button> : <button className="button button-primary button-small" onClick={() => void runQuery()}>Run query</button>}</div>
            <textarea className="sql-editor" spellCheck={false} aria-label="SQL query editor" value={sql} onChange={(event) => setSql(event.target.value)} />
            <div className="results-heading"><span>Results</span>{page && <><small>{page.rows.length.toLocaleString()} rows{page.truncated ? ' · output capped at ' + (page.truncationReason ?? 'limit') : ''}</small><button className="button button-subtle button-small" onClick={downloadCsv}>Export CSV</button></>}</div>
            {page ? <ResultsGrid page={page} /> : <div className="results-empty">Run a query to view results.</div>}
          </div>
        </div>
      )}
    </section>
  );
}

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

