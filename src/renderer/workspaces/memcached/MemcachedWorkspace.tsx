import { useEffect, useState } from 'react';
import type { DatabaseProfile } from '@shared/profiles';
import type { MemcachedValue } from '@shared/database';
import { useDatabaseSession } from '@renderer/state/database-sessions.js';

export function MemcachedWorkspace({ profile }: { profile: DatabaseProfile }) {
  const { state, reconnect } = useDatabaseSession(profile.id);
  const [stats, setStats] = useState<Record<string, string>>({});
  const [key, setKey] = useState('');
  const [value, setValue] = useState<MemcachedValue | null>(null);
  const [newValue, setNewValue] = useState('');
  const [ttl, setTtl] = useState('0');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (state.phase !== 'ready') return;
    void window.productivityApi.database.getMemcachedStats({ sessionId: state.session.sessionId }).then((result) => {
      if (result.ok) setStats(result.value); else setError(result.error.message);
    });
  }, [state]);
  async function lookup() {
    if (state.phase !== 'ready' || !key.trim()) return;
    const result = await window.productivityApi.database.getMemcachedValue({ sessionId: state.session.sessionId, key: key.trim() });
    if (result.ok) { setValue(result.value); setMessage(result.value ? 'Value loaded.' : 'Key was not found.'); setError(''); } else setError(result.error.message);
  }
  async function save() {
    if (state.phase !== 'ready' || !key.trim()) return;
    const result = await window.productivityApi.database.setMemcachedValue({ sessionId: state.session.sessionId, value: { key: key.trim(), value: newValue, ttlSeconds: Number(ttl) } });
    if (result.ok) { setMessage('Value stored.'); setError(''); } else setError(result.error.message);
  }
  async function remove() {
    if (state.phase !== 'ready' || !key.trim()) return;
    const endpoint = String(profile.options.host) + ':' + String(profile.options.port ?? 11211);
    if (!window.confirm('Delete key “' + key.trim() + '” from ' + endpoint + '?')) return;
    const result = await window.productivityApi.database.deleteMemcachedValue({ sessionId: state.session.sessionId, key: key.trim() });
    if (result.ok) { setValue(null); setMessage('Key deleted.'); setError(''); } else setError(result.error.message);
  }
  const endpoint = String(profile.options.host ?? '') + ':' + String(profile.options.port ?? 11211);
  return <section className="database-workspace">
    <header className="db-workspace-header"><div><p className="eyebrow">Memcached workspace</p><h1>{profile.name}</h1><span>{endpoint}</span></div><div className="connection-state">{state.phase === 'ready' ? <><i /> Connected</> : state.phase === 'connecting' ? 'Connecting…' : <button onClick={reconnect}>Reconnect</button>}</div></header>
    {error && <div className="workspace-error" role="alert">{error}</div>}
    {state.phase === 'error' ? <div className="connect-empty"><strong>Connection failed</strong><p>{state.error.message}</p><button className="button button-secondary" onClick={reconnect}>Try again</button></div> : state.phase === 'connecting' ? <div className="connect-empty">Opening a protected connection…</div> : <div className="data-workspace-grid">
      <aside className="object-tree"><div className="workspace-panel-title">SERVER STATS</div><p className="workspace-hint">Memcached does not provide general key enumeration. Enter a key you already know.</p><dl className="stats-list">{Object.entries(stats).map(([name, item]) => <div key={name}><dt>{name.replace(endpoint + ' ', '')}</dt><dd>{item}</dd></div>)}</dl></aside>
      <div className="data-main"><div className="workspace-panel-title">KEY LOOKUP</div><label className="field field-wide"><span>Key</span><input value={key} onChange={(event) => setKey(event.target.value)} maxLength={250} placeholder="cache:user:123" /></label><div className="data-toolbar"><button className="button button-secondary button-small" onClick={() => void lookup()}>Get value</button><button className="button button-subtle button-small" onClick={() => void remove()} disabled={!key.trim()}>Delete key</button></div>{value && <div className="key-value-panel"><div className="value-meta">{value.bytes.toLocaleString()} bytes · flags {value.flags}</div><pre>{decodeValue(value)}</pre></div>}<div className="workspace-panel-title">SET VALUE</div><textarea className="json-editor" value={newValue} onChange={(event) => setNewValue(event.target.value)} aria-label="Memcached value" /><div className="data-toolbar"><label className="ttl-field">TTL seconds<input value={ttl} onChange={(event) => setTtl(event.target.value)} inputMode="numeric" /></label><button className="button button-primary button-small" onClick={() => void save()} disabled={!key.trim()}>Store value</button></div>{message && <p className="workspace-hint" role="status">{message}</p>}</div>
    </div>}</section>;
}
function decodeValue(value: MemcachedValue): string { return typeof value.value === 'string' ? value.value : new TextDecoder().decode(value.value); }
