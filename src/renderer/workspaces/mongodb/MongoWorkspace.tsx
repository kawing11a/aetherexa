import { useEffect, useState } from 'react';
import type { DatabaseProfile } from '@shared/profiles';
import type { DatabaseObject, Namespace, DocumentPage } from '@shared/database';
import { useDatabaseSession } from '@renderer/state/database-sessions.js';

export function MongoWorkspace({ profile }: { profile: DatabaseProfile }) {
  const { state, reconnect } = useDatabaseSession(profile.id);
  const [databases, setDatabases] = useState<Namespace[]>([]);
  const [collections, setCollections] = useState<DatabaseObject[]>([]);
  const [database, setDatabase] = useState(String(profile.options.database ?? ''));
  const [collection, setCollection] = useState('');
  const [filter, setFilter] = useState('{}');
  const [page, setPage] = useState<DocumentPage | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (state.phase !== 'ready') return;
    void window.productivityApi.database.listNamespaces({ sessionId: state.session.sessionId }).then((result) => {
      if (!result.ok) { setError(result.error.message); return; }
      setDatabases(result.value);
      setDatabase((value) => value || result.value[0]?.name || '');
    });
  }, [state]);
  useEffect(() => {
    if (state.phase !== 'ready' || !database) return;
    void window.productivityApi.database.listObjects({ sessionId: state.session.sessionId, namespace: database }).then((result) => {
      if (!result.ok) { setError(result.error.message); return; }
      setCollections(result.value);
      setCollection((value) => result.value.some((item) => item.name === value) ? value : result.value[0]?.name ?? '');
    });
  }, [state, database]);

  async function find() {
    if (state.phase !== 'ready' || !database || !collection) return;
    try {
      const parsed: unknown = JSON.parse(filter);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Enter a JSON object for the filter.');
      const result = await window.productivityApi.database.findDocuments({ sessionId: state.session.sessionId, query: { database, collection, filter: parsed as Record<string, unknown>, limit: 500 } });
      if (result.ok) { setPage(result.value); setError(''); } else setError(result.error.message);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The filter is not valid JSON.'); }
  }

  return <section className="database-workspace">
    <header className="db-workspace-header"><div><p className="eyebrow">MongoDB workspace</p><h1>{profile.name}</h1><span>{String(profile.options.host ?? '')}</span></div><div className="connection-state">{state.phase === 'ready' ? <><i /> Connected</> : state.phase === 'connecting' ? 'Connecting…' : <button onClick={reconnect}>Reconnect</button>}</div></header>
    {error && <div className="workspace-error" role="alert">{error}</div>}
    {state.phase === 'error' ? <div className="connect-empty"><strong>Connection failed</strong><p>{state.error.message}</p><button className="button button-secondary" onClick={reconnect}>Try again</button></div> : state.phase === 'connecting' ? <div className="connect-empty">Opening a protected connection…</div> : <div className="data-workspace-grid">
      <aside className="object-tree"><div className="workspace-panel-title">DATABASES</div><div className="object-list">{databases.map((item) => <button className={database === item.name ? 'selected' : ''} key={item.name} onClick={() => setDatabase(item.name)}>{item.name}</button>)}</div><div className="workspace-panel-title">COLLECTIONS</div><div className="object-list">{collections.map((item) => <button className={collection === item.name ? 'selected' : ''} key={item.name} onClick={() => setCollection(item.name)}>{item.name}</button>)}</div></aside>
      <div className="data-main"><div className="data-toolbar"><label>Database<select value={database} onChange={(event) => setDatabase(event.target.value)}>{databases.map((item) => <option key={item.name}>{item.name}</option>)}</select></label><label>Collection<select value={collection} onChange={(event) => setCollection(event.target.value)}>{collections.map((item) => <option key={item.name}>{item.name}</option>)}</select></label></div><label className="editor-label">Filter <span>JSON</span></label><textarea className="json-editor" value={filter} onChange={(event) => setFilter(event.target.value)} spellCheck={false} aria-label="MongoDB JSON filter" /><div className="data-toolbar"><button className="button button-primary button-small" onClick={() => void find()} disabled={!collection}>Find documents</button><small>Results stop at 500 documents or 16 MiB.</small></div>{page && <div className="document-list">{page.documents.map((document, index) => <pre key={index}>{JSON.stringify(document, null, 2)}</pre>)}{!page.documents.length && <p>No documents matched.</p>}{page.truncated && <p className="results-note">The result set exceeded the display limit.</p>}</div>}</div>
    </div>}</section>;
}
