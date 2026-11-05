import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { SshProfile } from '@shared/profiles';
import type { HostKeyNotice, SftpEntry, SftpLocalEntry, SshSessionDescriptor, TerminalDescriptor, TransferProgress } from '@shared/database';

type View = 'terminal' | 'sftp';
type ContextTarget = { entry: SftpEntry; x: number; y: number };

export function SshWorkspace({ profile }: { profile: SshProfile }) {
  const [session, setSession] = useState<SshSessionDescriptor | null>(null);
  const [terminal, setTerminal] = useState<TerminalDescriptor | null>(null);
  const [sftpId, setSftpId] = useState<string | null>(null);
  const [view, setView] = useState<View>('terminal');
  const [remotePath, setRemotePath] = useState('.');
  const [remoteEntries, setRemoteEntries] = useState<SftpEntry[]>([]);
  const [localPath, setLocalPath] = useState('');
  const [localEntries, setLocalEntries] = useState<SftpLocalEntry[]>([]);
  const [notice, setNotice] = useState<HostKeyNotice | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextTarget | null>(null);
  const [readyDrag, setReadyDrag] = useState<{ path: string; dragId: string } | null>(null);
  const [transfer, setTransfer] = useState<TransferProgress | null>(null);
  const terminalHost = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const liveSession = useRef<SshSessionDescriptor | null>(null);
  const disconnectedSessions = useRef(new Set<string>());
  const liveTerminal = useRef<TerminalDescriptor | null>(null);
  liveSession.current = session; liveTerminal.current = terminal;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => window.productivityApi.ssh.onHostKey((value) => { if (value.profileId === profile.id) setNotice(value); }), [profile.id]);
  useEffect(() => window.productivityApi.sftp.onTransferProgress(setTransfer), []);
  useEffect(() => window.productivityApi.ssh.onDisconnect((event) => {
    disconnectedSessions.current.add(event.sessionId);
    if (disconnectedSessions.current.size > 128) disconnectedSessions.current.delete(disconnectedSessions.current.values().next().value!);
    if (event.sessionId === liveSession.current?.sessionId) { liveSession.current = null; liveTerminal.current = null; setSession(null); setTerminal(null); setSftpId(null); setRemoteEntries([]); setError(event.message); }
  }), []);
  useEffect(() => {
    if (!terminal || !terminalHost.current) return;
    const instance = new Terminal({ cursorBlink: true, fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 12, theme: { background: '#0c1218', foreground: '#d4e0e8' } });
    const fit = new FitAddon(); instance.loadAddon(fit); instance.open(terminalHost.current); fit.fit();
    instance.onData((data) => void window.productivityApi.ssh.writeTerminal({ terminalId: terminal.terminalId, data }));
    const unsubscribe = window.productivityApi.ssh.onTerminalData((event) => { if (event.terminalId === terminal.terminalId) instance.write(event.data); });
    void window.productivityApi.ssh.attachTerminal({ terminalId: terminal.terminalId });
    const resize = new ResizeObserver(() => { fit.fit(); void window.productivityApi.ssh.resizeTerminal({ terminalId: terminal.terminalId, cols: instance.cols, rows: instance.rows }); });
    resize.observe(terminalHost.current);
    return () => { resize.disconnect(); unsubscribe(); instance.dispose(); };
  }, [terminal]);
  useEffect(() => () => { const activeTerminal = liveTerminal.current; const activeSession = liveSession.current; if (activeTerminal) void window.productivityApi.ssh.closeTerminal({ terminalId: activeTerminal.terminalId }); if (activeSession) void window.productivityApi.ssh.disconnect({ sessionId: activeSession.sessionId }); }, []);

  async function listRemote(id: string, next: string) {
    const result = await window.productivityApi.sftp.list({ sftpId: id, path: next });
    if (!mounted.current) return;
    if (result.ok) { setRemotePath(next); setRemoteEntries(result.value); setError(''); } else setError(result.error.message);
  }
  async function listLocal(next?: string) {
    const result = await window.productivityApi.sftp.listLocal({ ...(next ? { path: next } : {}) });
    if (!mounted.current) return;
    if (result.ok) { setLocalPath(result.value.path); setLocalEntries(result.value.entries); } else setError(result.error.message);
  }
  async function connect() {
    if (busy) return;
    setBusy(true); setError('');
    const result = await window.productivityApi.ssh.connect({ profileId: profile.id });
    if (!mounted.current) { if (result.ok) await window.productivityApi.ssh.disconnect({ sessionId: result.value.sessionId }); return; }
    setBusy(false);
    if (!result.ok) { setError(result.error.message); setNotice(null); return; }
    if (disconnectedSessions.current.delete(result.value.sessionId)) { setError('The SSH connection closed before it could be opened.'); return; }
    liveSession.current = result.value; setSession(result.value);
    const term = await window.productivityApi.ssh.openTerminal({ sessionId: result.value.sessionId, cols: 100, rows: 28 });
    if (!mounted.current) { if (term.ok) await window.productivityApi.ssh.closeTerminal({ terminalId: term.value.terminalId }); await window.productivityApi.ssh.disconnect({ sessionId: result.value.sessionId }); return; }
    if (disconnectedSessions.current.delete(result.value.sessionId)) { liveSession.current = null; setSession(null); setError('The SSH connection closed before the terminal opened.'); return; }
    if (term.ok) { liveTerminal.current = term.value; setTerminal(term.value); } else setError(term.error.message);
    const fs = await window.productivityApi.sftp.open({ sessionId: result.value.sessionId });
    if (!mounted.current) { await window.productivityApi.ssh.disconnect({ sessionId: result.value.sessionId }); return; }
    if (fs.ok) { setSftpId(fs.value.sftpId); await Promise.all([listRemote(fs.value.sftpId, fs.value.initialPath), listLocal()]); } else setError(fs.error.message);
  }
  async function openLocal() {
    const result = await window.productivityApi.ssh.openLocalTerminal({ cols: 100, rows: 28 });
    if (!result.ok) { if (mounted.current) setError(result.error.message); return; }
    if (!mounted.current) { await window.productivityApi.ssh.closeTerminal({ terminalId: result.value.terminalId }); return; }
    liveTerminal.current = result.value; setTerminal(result.value); setView('terminal'); setError('');
  }
  async function disconnect() {
    const currentTerminal = terminal; const currentSession = session;
    liveTerminal.current = null; liveSession.current = null;
    if (currentTerminal) await window.productivityApi.ssh.closeTerminal({ terminalId: currentTerminal.terminalId });
    if (currentSession) await window.productivityApi.ssh.disconnect({ sessionId: currentSession.sessionId });
    setTerminal(null); setSession(null); setSftpId(null); setRemoteEntries([]); setRemotePath('.');
  }
  async function review(accept: boolean) {
    if (!notice) return;
    let replaceChangedKey = false;
    if (notice.changed && accept) { replaceChangedKey = window.confirm(`The saved SSH host key changed. Replace it only after verifying through a trusted channel.\nOld: ${notice.previousFingerprint}\nNew: ${notice.currentFingerprint}`); if (!replaceChangedKey) return; }
    const result = await window.productivityApi.ssh.reviewHostKey({ requestId: notice.requestId, accept, replaceChangedKey });
    if (!result.ok && mounted.current) setError(result.error.message);
    if (mounted.current) setNotice(null);
  }
  async function upload(localPaths: string[]) {
    if (!sftpId || localPaths.length === 0) return;
    const result = await window.productivityApi.sftp.uploadPaths({ sftpId, remoteDirectory: remotePath, localPaths });
    if (!result.ok) setError(result.error.message); else await listRemote(sftpId, remotePath);
  }
  async function uploadFromPicker() {
    if (!sftpId) return;
    const result = await window.productivityApi.sftp.upload({ sftpId, remotePath: remotePath === '.' ? './' : remotePath.replace(/\/$/, '') + '/' });
    if (!result.ok && result.error.code !== 'transfer-cancelled') setError(result.error.message);
    else if (result.ok) await listRemote(sftpId, remotePath);
  }
  async function createFolder() {
    const name = window.prompt('New folder name')?.trim(); if (!name || !sftpId) return;
    const result = await window.productivityApi.sftp.makeDirectory({ sftpId, path: joinRemote(remotePath, name) });
    if (!result.ok) setError(result.error.message); else await listRemote(sftpId, remotePath);
  }
  function enterRemote(entry: SftpEntry) {
    if (!sftpId) return;
    const target = joinRemote(remotePath, entry.name);
    if (entry.type === 'directory') void listRemote(sftpId, target);
    else if (entry.type === 'file') void window.productivityApi.sftp.downloadToDirectory({ sftpId, remotePath: target, localDirectory: localPath }).then((result) => { if (!result.ok) setError(result.error.message); else void listLocal(localPath); });
  }
  async function contextAction(action: 'rename' | 'details' | 'zip' | 'tar' | 'targz' | 'delete' | 'prepare-drag') {
    const target = contextMenu; setContextMenu(null); if (!target || !sftpId) return;
    const path = joinRemote(remotePath, target.entry.name);
    if (action === 'rename') {
      const name = window.prompt('Rename to', target.entry.name)?.trim(); if (!name || name === target.entry.name) return;
      const result = await window.productivityApi.sftp.rename({ sftpId, from: path, to: joinRemote(remotePath, name) });
      if (!result.ok) setError(result.error.message); else await listRemote(sftpId, remotePath);
    } else if (action === 'details') {
      const result = await window.productivityApi.sftp.details({ sftpId, remotePath: path });
      if (result.ok) { const item = result.value; window.alert(`${item.name}\nType: ${item.type}\nSize: ${item.size} bytes\nModified: ${new Date(item.modifiedAt).toLocaleString()}\nPermissions: ${item.permissions.toString(8)}\nOwner: ${item.owner}\nGroup: ${item.group}\nPath: ${item.path}`); } else setError(result.error.message);
    } else if (action === 'prepare-drag') {
      const result = await window.productivityApi.sftp.prepareDrag({ sftpId, remotePath: path });
      if (!result.ok) setError(result.error.message); else { setReadyDrag({ path, dragId: result.value.dragId }); setError(`Ready to drag ${target.entry.name} outside Aetherexa.`); }
    } else if (action === 'delete') {
      if (!window.confirm(`Delete ${target.entry.name}? Remote folders must be empty.`)) return;
      const result = await window.productivityApi.sftp.remove({ sftpId, path, directory: target.entry.type === 'directory' });
      if (!result.ok) setError(result.error.message); else await listRemote(sftpId, remotePath);
    } else {
      const format = action === 'targz' ? 'tar.gz' : action;
      const result = await window.productivityApi.sftp.archive({ sftpId, remotePath: path, format });
      if (!result.ok) setError(result.error.message); else await listRemote(sftpId, remotePath);
    }
  }
  async function dropToRemote(event: React.DragEvent) {
    event.preventDefault();
    const localPaths = window.productivityApi.sftp.getDroppedPaths(Array.from(event.dataTransfer.files));
    const internal = event.dataTransfer.getData('application/x-aetherexa-local-path');
    await upload(localPaths.length ? localPaths : internal ? [internal] : []);
  }
  async function dropToLocal(event: React.DragEvent) {
    event.preventDefault();
    const internal = event.dataTransfer.getData('application/x-aetherexa-remote-path');
    if (internal && sftpId) {
      const result = await window.productivityApi.sftp.downloadToDirectory({ sftpId, remotePath: internal, localDirectory: localPath });
      if (!result.ok) setError(result.error.message); else void listLocal(localPath);
    }
  }
  function startRemoteDrag(event: React.DragEvent, entry: SftpEntry) {
    if (!sftpId || (entry.type !== 'file' && entry.type !== 'directory')) { event.preventDefault(); return; }
    const path = joinRemote(remotePath, entry.name);
    event.dataTransfer.setData('application/x-aetherexa-remote-path', path);
    event.dataTransfer.setData('text/plain', entry.name);
    if (readyDrag?.path !== path) { event.preventDefault(); setError(`Choose Prepare to drag for ${entry.name} first.`); return; }
    void window.productivityApi.sftp.startDrag({ dragId: readyDrag.dragId });
  }
  function startLocalDrag(event: React.DragEvent, entry: SftpLocalEntry) {
    if (entry.type !== 'file' && entry.type !== 'directory') { event.preventDefault(); return; }
    event.dataTransfer.setData('application/x-aetherexa-local-path', entry.path);
    event.dataTransfer.setData('text/plain', entry.name);
    if (entry.type === 'file') void window.productivityApi.sftp.startDrag({ localPath: entry.path });
  }

  const localParent = parentLocal(localPath);
  return <section className="database-workspace ssh-workspace">
    <header className="db-workspace-header"><div><span>SSH / SFTP</span><h1>{profile.name}</h1></div><div className="ssh-header-actions"><span className="connection-state"><i />{session ? 'Connected' : terminal?.local ? 'Local terminal' : 'Disconnected'}</span>{session && <button className="button button-secondary" onClick={() => void disconnect()}>Disconnect</button>}{terminal?.local && <button className="button button-secondary" onClick={() => void disconnect()}>Close terminal</button>}{!session && !terminal?.local && <><button className="button button-secondary" disabled={busy} onClick={() => void openLocal()}>Local PowerShell</button><button className="button button-primary" disabled={busy} onClick={() => void connect()}>{busy ? 'Connecting…' : 'Connect'}</button></>}</div></header>
    {error && <div className="workspace-error" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss">×</button></div>}
    {notice && <div className="host-key-prompt" role="dialog" aria-modal="true"><strong>{notice.changed ? 'SSH host key changed' : 'Trust SSH host key?'}</strong><p>{notice.host}:{notice.port}</p><code>{notice.currentFingerprint}</code>{notice.previousFingerprint && <small>Previously saved: {notice.previousFingerprint}</small>}<div><button className="button button-primary" onClick={() => void review(true)}>{notice.changed ? 'Review and replace key' : 'Trust and connect'}</button><button className="button button-secondary" onClick={() => void review(false)}>Reject</button></div></div>}
    {session || terminal?.local ? <>
      <nav className="ssh-workspace-tabs" aria-label="SSH workspace views"><button className={view === 'terminal' ? 'active' : ''} onClick={() => setView('terminal')}>Terminal</button>{session && <button className={view === 'sftp' ? 'active' : ''} onClick={() => setView('sftp')}>SFTP files</button>}</nav>
      <section className="terminal-panel ssh-terminal-workspace" hidden={view !== 'terminal'}><div className="ssh-panel-heading"><strong>Terminal</strong><span>{session ? `${profile.username}@${profile.host}` : 'Local PowerShell'}</span></div><div className="terminal-host" ref={terminalHost}>{!terminal && <p>Opening terminal…</p>}</div></section>
      {view === 'sftp' && session && <div className="sftp-two-pane">
        <section className="sftp-panel" onDragOver={(event) => event.preventDefault()} onDrop={(event) => void dropToLocal(event)}>
          <div className="ssh-panel-heading"><strong>Local files</strong><button className="button button-secondary" onClick={() => void window.productivityApi.sftp.chooseLocalDirectory().then((r) => r.ok && r.value ? listLocal(r.value) : undefined)}>Choose folder</button></div>
          <div className="sftp-path"><button disabled={!localPath || localPath === parentLocal(localPath)} onClick={() => void listLocal(localParent)}>↑</button><span title={localPath}>{localPath || 'Loading local folder…'}</span><button onClick={() => void listLocal(localPath)}>Refresh</button></div>
          <div className="sftp-list">{localEntries.map((entry) => <div className="sftp-entry" key={entry.path} draggable={entry.type === 'file' || entry.type === 'directory'} onDragStart={(event) => startLocalDrag(event, entry)} onDoubleClick={() => entry.type === 'directory' && void listLocal(entry.path)}><button className="sftp-entry-name" onClick={() => entry.type === 'directory' && void listLocal(entry.path)}><span>{entry.type === 'directory' ? '▸' : '•'}</span>{entry.name}</button><small>{entry.type === 'file' ? `${entry.size} B` : entry.type}</small></div>)}</div>
        </section>
        <section className="sftp-panel" onDragOver={(event) => event.preventDefault()} onDrop={(event) => void dropToRemote(event)}>
          <div className="ssh-panel-heading"><strong>Remote files</strong><button className="button button-secondary" onClick={() => void uploadFromPicker()}>Upload</button><button className="button button-secondary" onClick={() => void createFolder()}>＋ Folder</button></div>
          <div className="sftp-path"><button disabled={isRemoteRoot(remotePath)} onClick={() => sftpId && void listRemote(sftpId, parentRemote(remotePath))}>↑</button><span title={remotePath}>{remotePath}</span><button onClick={() => sftpId && void listRemote(sftpId, remotePath)}>Refresh</button></div>
          <div className="sftp-list">{remoteEntries.map((entry) => <div className="sftp-entry" key={entry.name} draggable={entry.type === 'directory' || (entry.type === 'file' && readyDrag?.path === joinRemote(remotePath, entry.name))} onDragStart={(event) => startRemoteDrag(event, entry)} onDoubleClick={() => enterRemote(entry)} onContextMenu={(event) => { event.preventDefault(); setContextMenu({ entry, x: event.clientX, y: event.clientY }); }}><button className="sftp-entry-name" onClick={() => entry.type === 'directory' && sftpId && void listRemote(sftpId, joinRemote(remotePath, entry.name))}><span>{entry.type === 'directory' ? '▸' : '•'}</span>{entry.name}</button><small>{entry.type === 'file' ? `${entry.size} B` : entry.type}</small></div>)}</div>
          {contextMenu && <div className="sftp-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onMouseLeave={() => setContextMenu(null)}>{(contextMenu.entry.type === 'file' || contextMenu.entry.type === 'directory') && <button onClick={() => void contextAction('prepare-drag')}>Prepare to drag</button>}{contextMenu.entry.type === 'directory' && <><button onClick={() => void contextAction('zip')}>Create ZIP</button><button onClick={() => void contextAction('tar')}>Create TAR</button><button onClick={() => void contextAction('targz')}>Create TAR.GZ</button></>}<button onClick={() => void contextAction('rename')}>Rename</button><button onClick={() => void contextAction('details')}>File details</button><button onClick={() => void contextAction('delete')}>Delete</button></div>}
        </section>
        {transfer && <div className="sftp-transfer-status" role="status">{transfer.direction} · {transfer.fileName} · {transfer.state}{transfer.totalBytes !== null ? ` · ${transfer.transferredBytes} / ${transfer.totalBytes} B` : ` · ${transfer.transferredBytes} B`}</div>}
      </div>}
    </> : <div className="connect-empty"><strong>Connect to {profile.host}</strong><p>Host key verification runs before terminal and file transfer access.</p></div>}
  </section>;
}

function joinRemote(base: string, name: string): string { return base === '.' ? name : `${base.replace(/\/$/, '')}/${name}`; }
function parentRemote(path: string): string { if (path === '.' || path === '/') return path; const parent = path.replace(/\/$/, '').split('/').slice(0, -1).join('/'); return parent || (path.startsWith('/') ? '/' : '.'); }
function isRemoteRoot(path: string): boolean { return path === '.' || path === '/'; }
function parentLocal(path: string): string { if (!path) return ''; if (/^[A-Za-z]:\\?$/.test(path) || path === '/') return path; const normalized = path.replace(/[\\/]$/, ''); const index = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/')); if (index === 2 && /^[A-Za-z]:\\/.test(normalized)) return normalized.slice(0, 3); return index <= 0 ? normalized.slice(0, 1) : normalized.slice(0, index); }
