import { useEffect, useRef, useState } from 'react';
import type { FileTransferProfile } from '@shared/profiles';
import type { FileSessionDescriptor, RemoteEntry } from '@shared/files';
import type { HostKeyNotice, TransferProgress } from '@shared/database';

export function FilesWorkspace({ profile }: { profile: FileTransferProfile }) {
  const endpoint = profile.protocol === 's3' ? profile.bucket : 'host' in profile ? profile.host : '';
  const [session, setSession] = useState<FileSessionDescriptor | null>(null);
  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [notice, setNotice] = useState<HostKeyNotice | null>(null);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const liveSession = useRef<FileSessionDescriptor | null>(null);
  liveSession.current = session;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; const current = liveSession.current; if (current) void window.productivityApi.files.disconnect({ sessionId: current.sessionId }); }; }, []);
  useEffect(() => window.productivityApi.files.onHostKey((item) => { if (item.profileId === profile.id) setNotice(item); }), [profile.id]);
  useEffect(() => window.productivityApi.files.onTransferProgress((item) => setProgress(item)), []);

  async function list(id: string, next: string) { const result = await window.productivityApi.files.list({ sessionId: id, path: next }); if (!mounted.current) return; if (result.ok) { setPath(next); setEntries(result.value); setError(''); } else setError(result.error.message); }
  async function connect() {
    if (busy) return;
    if (profile.protocol === 'ftp' && !window.confirm('Plain FTP does not encrypt your credentials or file contents. Connect anyway?')) return;
    setBusy(true); setError('');
    const result = await window.productivityApi.files.connect({ profileId: profile.id });
    if (!mounted.current) { if (result.ok) await window.productivityApi.files.disconnect({ sessionId: result.value.sessionId }); return; }
    setBusy(false);
    if (!result.ok) { setError(result.error.message); setNotice(null); return; }
    liveSession.current = result.value; setSession(result.value); setNotice(null); await list(result.value.sessionId, result.value.initialPath);
  }
  async function disconnect() { const current = session; liveSession.current = null; if (current) await window.productivityApi.files.disconnect({ sessionId: current.sessionId }); setSession(null); setEntries([]); setPath('/'); setProgress(null); }
  async function review(accept: boolean) {
    if (!notice) return;
    let replaceChangedKey = false;
    if (notice.changed && accept) { replaceChangedKey = window.confirm(`The saved SSH host key changed. Verify it before replacing the saved key.\nOld: ${notice.previousFingerprint}\nNew: ${notice.currentFingerprint}`); if (!replaceChangedKey) return; }
    const result = await window.productivityApi.files.reviewHostKey({ requestId: notice.requestId, accept, replaceChangedKey });
    if (!result.ok) setError(result.error.message);
    setNotice(null);
  }
  async function upload() { if (!session) return; const destination = path === '/' ? '/' : path.replace(/\/$/, '') + '/'; const result = await window.productivityApi.files.upload({ sessionId: session.sessionId, path: destination }); if (!result.ok && result.error.code !== 'transfer-cancelled') setError(result.error.message); else if (result.ok) await list(session.sessionId, path); }
  async function createFolder() { if (!session) return; const name = window.prompt('New folder name'); if (!name?.trim()) return; const target = joinRemote(path, name.trim()); const result = await window.productivityApi.files.makeDirectory({ sessionId: session.sessionId, path: target }); if (!result.ok) setError(result.error.message); else await list(session.sessionId, path); }
  async function remove(entry: RemoteEntry) { if (!session) return; const target = joinRemote(path, entry.name); const prefixDelete = entry.type === 'directory' && (profile.protocol.startsWith('ftp') || profile.protocol === 's3'); const location = profile.protocol === 's3' ? `Bucket: ${profile.bucket}\nPrefix: ${target}` : target; if (!window.confirm(`Delete ${prefixDelete ? 'this folder and its contents' : 'this item'}?\n\n${location}`)) return; const result = await window.productivityApi.files.remove({ sessionId: session.sessionId, path: target, directory: entry.type === 'directory' }); if (!result.ok) setError(result.error.message); else await list(session.sessionId, path); }
  function open(entry: RemoteEntry) { if (!session) return; const target = joinRemote(path, entry.name); if (entry.type === 'directory') void list(session.sessionId, target); else if (entry.type === 'file') void window.productivityApi.files.download({ sessionId: session.sessionId, path: target }).then((result) => { if (!result.ok && result.error.code !== 'transfer-cancelled') setError(result.error.message); }); }
  const parent = parentRemote(path);
  return <section className="database-workspace files-workspace">
    <header className="db-workspace-header"><div><span>{profile.protocol.toUpperCase()} FILES</span><h1>{profile.name}</h1></div><div className="ssh-header-actions"><span className="connection-state"><i />{session ? `Connected to ${endpoint}` : 'Disconnected'}</span>{session ? <button className="button button-secondary" onClick={() => void disconnect()}>Disconnect</button> : <button className="button button-primary" disabled={busy} onClick={() => void connect()}>{busy ? 'Connecting…' : 'Connect'}</button>}</div></header>
    {error && <div className="workspace-error" role="alert">{error}</div>}
    {notice && <div className="host-key-prompt" role="dialog" aria-modal="true"><strong>{notice.changed ? 'SSH host key changed' : 'Trust SSH host key?'}</strong><p>{notice.host}:{notice.port}</p><code>{notice.currentFingerprint}</code>{notice.previousFingerprint && <small>Previously saved: {notice.previousFingerprint}</small>}<div><button className="button button-primary" onClick={() => void review(true)}>{notice.changed ? 'Review and replace key' : 'Trust and connect'}</button><button className="button button-secondary" onClick={() => void review(false)}>Reject</button></div></div>}
    {session ? <><div className="files-toolbar"><button className="button button-secondary" onClick={() => void upload()}>Upload</button><button className="button button-secondary" onClick={() => void createFolder()}>＋ Folder</button><button className="button button-subtle" disabled={path === '/'} onClick={() => void list(session.sessionId, parent)}>↑ Parent</button><span className="files-current-path">{path}</span></div><div className="files-table"><div className="files-table-head"><span>Name</span><span>Type</span><span>Size</span><span>Modified</span><span /></div>{entries.map((entry) => <div className="files-row" key={entry.name}><button className="files-entry-name" onClick={() => open(entry)}>{entry.type === 'directory' ? '▸ ' : '• '}{entry.name}</button><span>{entry.type}</span><span>{entry.size === null ? '—' : `${entry.size} B`}</span><span>{entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : '—'}</span><button className="files-delete" onClick={() => void remove(entry)} aria-label={`Delete ${entry.name}`}>Delete</button></div>)}{entries.length === 0 && <p className="field-hint">This folder is empty.</p>}</div>{progress && <div className="files-progress" role="status">{progress.direction}: {progress.fileName} · {progress.state}{progress.totalBytes ? ` · ${progress.transferredBytes} / ${progress.totalBytes} B` : ` · ${progress.transferredBytes} B`}</div>}</> : <div className="connect-empty"><strong>Connect directly to {endpoint}</strong><p>This file connection does not open or require an SSH terminal.</p></div>}
  </section>;
}

function joinRemote(base: string, name: string): string { return `${base === '/' ? '' : base.replace(/\/$/, '')}/${name.replace(/^\/+/, '')}` || '/'; }
function parentRemote(path: string): string { if (path === '/') return '/'; const segments = path.replace(/\/$/, '').split('/').filter(Boolean); segments.pop(); return segments.length ? `/${segments.join('/')}` : '/'; }
