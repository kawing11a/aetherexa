import { useRef, useState } from 'react';
import type { DatabaseProfile } from '@shared/profiles';
import type { KeyPage, RedisReply } from '@shared/database';
import { useDatabaseSession } from '@renderer/state/database-sessions.js';

export function RedisWorkspace({ profile }: { profile: DatabaseProfile }) {
  const { state, reconnect } = useDatabaseSession(profile.id);
  const [pattern, setPattern] = useState('*');
  const [keys, setKeys] = useState<KeyPage | null>(null);
  const [command, setCommand] = useState('PING');
  const [reply, setReply] = useState<RedisReply | null>(null);
  const [error, setError] = useState('');
  const scanGeneration = useRef(0);

  async function scan(cursor = '0') {
    if (state.phase !== 'ready') return;
    const generation = scanGeneration.current;
    const scanPattern = pattern;
    const result = await window.productivityApi.database.scanKeys({ sessionId: state.session.sessionId, pattern: scanPattern, cursor, count: 200 });
    if (generation !== scanGeneration.current) return;
    if (result.ok) { setKeys(result.value); setError(''); } else setError(result.error.message);
  }
  async function execute() {
    if (state.phase !== 'ready') return;
    const tokens = tokenize(command);
    if (!tokens.length) return;
    if (mayMutate(tokens[0]) && !window.confirm('This command may change data on ' + String(profile.options.host) + '. Run it?')) return;
    const result = await window.productivityApi.database.executeRedis({ sessionId: state.session.sessionId, tokens });
    if (result.ok) { setReply(result.value); setError(''); } else setError(result.error.message);
  }

  return <section className="database-workspace">
    <header className="db-workspace-header"><div><p className="eyebrow">Redis workspace</p><h1>{profile.name}</h1><span>{String(profile.options.host ?? '')}:{String(profile.options.port ?? 6379)}</span></div><div className="connection-state">{state.phase === 'ready' ? <><i /> Connected</> : state.phase === 'connecting' ? 'Connecting…' : <button onClick={reconnect}>Reconnect</button>}</div></header>
    {error && <div className="workspace-error" role="alert">{error}</div>}
    {state.phase === 'error' ? <div className="connect-empty"><strong>Connection failed</strong><p>{state.error.message}</p><button className="button button-secondary" onClick={reconnect}>Try again</button></div> : state.phase === 'connecting' ? <div className="connect-empty">Opening a protected connection…</div> : <div className="redis-layout">
      <aside className="object-tree"><div className="workspace-panel-title">KEY BROWSER</div><label className="field"><span>Pattern</span><input value={pattern} onChange={(event) => { scanGeneration.current += 1; setKeys(null); setPattern(event.target.value); }} /></label><button className="button button-secondary button-small" onClick={() => void scan()}>Scan keys</button><div className="object-list">{keys?.keys.map((key) => <button key={key} onClick={() => setCommand('GET ' + quoteToken(key))}>{key}</button>)}</div>{keys?.nextCursor && <button className="button button-subtle button-small" onClick={() => void scan(keys.nextCursor ?? '0')}>Next page</button>}</aside>
      <div className="data-main"><div className="workspace-panel-title">COMMAND</div><p className="workspace-hint">Commands run once. The app does not retry commands after a connection error.</p><textarea className="json-editor command-editor" value={command} onChange={(event) => setCommand(event.target.value)} aria-label="Redis command" spellCheck={false} /><div className="data-toolbar"><button className="button button-primary button-small" onClick={() => void execute()}>Run command</button><small>Commands such as SET, DEL, and FLUSHDB ask for confirmation.</small></div><div className="workspace-panel-title">REPLY</div><pre className="key-value-panel">{reply ? JSON.stringify(reply, null, 2) : 'Run a Redis command to see its reply.'}</pre></div>
    </div>}</section>;
}

function tokenize(input: string): string[] { return [...input.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g)].map((match) => (match[1] ?? match[2] ?? match[3] ?? '').replaceAll('\\"', '"').replaceAll("\\'", "'")); }
function quoteToken(value: string): string { return /\s/.test(value) ? '"' + value.replaceAll('"', '\\"') + '"' : value; }
function mayMutate(command: string): boolean { return new Set(['SET','MSET','DEL','UNLINK','INCR','DECR','HSET','HDEL','LPUSH','RPUSH','LPOP','RPOP','SADD','SREM','ZADD','ZREM','EXPIRE','PERSIST','FLUSHDB','FLUSHALL','RENAME','COPY','EVAL','EVALSHA']).has(command.toUpperCase()); }
