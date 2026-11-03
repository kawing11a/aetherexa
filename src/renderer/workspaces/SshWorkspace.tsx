import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { SshProfile } from '@shared/profiles';
import type { HostKeyNotice, SftpEntry, SshSessionDescriptor, TerminalDescriptor } from '@shared/database';

export function SshWorkspace({ profile }: { profile: SshProfile }) {
  const [session, setSession] = useState<SshSessionDescriptor | null>(null);
  const [terminal, setTerminal] = useState<TerminalDescriptor | null>(null);
  const [sftpId, setSftpId] = useState<string | null>(null);
  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [notice, setNotice] = useState<HostKeyNotice | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const terminalHost = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const liveSession = useRef<SshSessionDescriptor | null>(null);
  const disconnectedSessions = useRef(new Set<string>());
  const liveTerminal = useRef<TerminalDescriptor | null>(null);
  liveSession.current = session; liveTerminal.current = terminal;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => window.productivityApi.ssh.onHostKey((value) => { if (value.profileId === profile.id) setNotice(value); }), [profile.id]);
  useEffect(() => window.productivityApi.ssh.onDisconnect((event) => {
    disconnectedSessions.current.add(event.sessionId);
    if (disconnectedSessions.current.size > 128) disconnectedSessions.current.delete(disconnectedSessions.current.values().next().value!);
    if (event.sessionId === liveSession.current?.sessionId) { liveSession.current = null; liveTerminal.current = null; setSession(null); setTerminal(null); setSftpId(null); setEntries([]); setError(event.message); }
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

  async function list(id: string, next: string) { const result = await window.productivityApi.sftp.list({ sftpId: id, path: next }); if (!mounted.current) return; if (result.ok) { setPath(next); setEntries(result.value); setError(''); } else setError(result.error.message); }
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
    if (fs.ok) { setSftpId(fs.value.sftpId); await list(fs.value.sftpId, '/'); } else setError(fs.error.message);
  }
  async function openLocal() {
    const result = await window.productivityApi.ssh.openLocalTerminal({ cols: 100, rows: 28 });
    if (!result.ok) { if (mounted.current) setError(result.error.message); return; }
    if (!mounted.current) { await window.productivityApi.ssh.closeTerminal({ terminalId: result.value.terminalId }); return; }
    liveTerminal.current = result.value; setTerminal(result.value); setError('');
  }
  async function disconnect() {
    const currentTerminal = terminal; const currentSession = session;
    liveTerminal.current = null; liveSession.current = null;
    if (currentTerminal) await window.productivityApi.ssh.closeTerminal({ terminalId: currentTerminal.terminalId });
    if (currentSession) await window.productivityApi.ssh.disconnect({ sessionId: currentSession.sessionId });
    setTerminal(null); setSession(null); setSftpId(null); setEntries([]);
  }
  async function review(accept: boolean) {
    if (!notice) return;
    let replaceChangedKey = false;
    if (notice.changed && accept) { replaceChangedKey = window.confirm(`The saved SSH host key changed. Replace it only after verifying through a trusted channel.\nOld: ${notice.previousFingerprint}\nNew: ${notice.currentFingerprint}`); if (!replaceChangedKey) return; }
    const result = await window.productivityApi.ssh.reviewHostKey({ requestId: notice.requestId, accept, replaceChangedKey });
    if (!result.ok && mounted.current) setError(result.error.message);
    if (mounted.current) setNotice(null);
  }
  async function upload() {
    if (!sftpId) return;
    const remotePath = path === '/' ? '/' : path.replace(/\/$/, '') + '/';
    const result = await window.productivityApi.sftp.upload({ sftpId, remotePath });
    if (!result.ok && result.error.code !== 'transfer-cancelled') setError(result.error.message); else if (result.ok) await list(sftpId, path);
  }
  function enterEntry(entry: SftpEntry) {
    if (!sftpId) return;
    const target = (path === '/' ? '' : path.replace(/\/$/, '')) + '/' + entry.name;
    if (entry.type === 'directory') void list(sftpId, target);
    else if (entry.type === 'file') void window.productivityApi.sftp.download({ sftpId, remotePath: target }).then((result) => { if (!result.ok && result.error.code !== 'transfer-cancelled') setError(result.error.message); });
  }

  const localTerminal = terminal?.local === true;
  return <section className="database-workspace ssh-workspace">
    <header className="db-workspace-header"><div><span>SSH / SFTP</span><h1>{profile.name}</h1></div><div className="ssh-header-actions"><span className="connection-state"><i />{localTerminal ? 'Local terminal' : session ? 'Connected' : 'Disconnected'}</span>{session && <button className="button button-secondary" onClick={() => void disconnect()}>Disconnect</button>}{localTerminal && <button className="button button-secondary" onClick={() => void disconnect()}>Close terminal</button>}{!session && !localTerminal && <><button className="button button-secondary" disabled={busy} onClick={() => void openLocal()}>Local PowerShell</button><button className="button button-primary" disabled={busy} onClick={() => void connect()}>{busy ? 'Connecting…' : 'Connect'}</button></>}</div></header>
    {error && <div className="workspace-error" role="alert">{error}</div>}
    {notice && <div className="host-key-prompt" role="dialog" aria-modal="true"><strong>{notice.changed ? 'SSH host key changed' : 'Trust SSH host key?'}</strong><p>{notice.host}:{notice.port}</p><code>{notice.currentFingerprint}</code>{notice.previousFingerprint && <small>Previously saved: {notice.previousFingerprint}</small>}<div><button className="button button-primary" onClick={() => void review(true)}>{notice.changed ? 'Review and replace key' : 'Trust and connect'}</button><button className="button button-secondary" onClick={() => void review(false)}>Reject</button></div></div>}
    {session || localTerminal ? <div className={session ? 'ssh-split' : 'ssh-split ssh-local-only'}><section className="terminal-panel"><div className="ssh-panel-heading"><strong>Terminal</strong><span>{session ? `${profile.username}@${profile.host}` : 'Local PowerShell'}</span></div><div className="terminal-host" ref={terminalHost}>{!terminal && <p>Opening terminal…</p>}</div></section>{session && <section className="sftp-panel"><div className="ssh-panel-heading"><strong>SFTP files</strong><button className="button button-secondary" onClick={() => void upload()}>Upload</button></div><div className="sftp-path"><button disabled={path === '/'} onClick={() => { const parent = path.replace(/\/$/, '').split('/').slice(0, -1).join('/') || '/'; if (sftpId) void list(sftpId, parent); }}>↑</button><span>{path}</span><button onClick={() => { const name = window.prompt('New folder name'); if (name && sftpId) void window.productivityApi.sftp.makeDirectory({ sftpId, path: (path === '/' ? '' : path.replace(/\/$/, '')) + '/' + name }).then((result) => result.ok ? list(sftpId, path) : setError(result.error.message)); }}>＋ Folder</button></div><div className="sftp-list">{entries.map((entry) => <div className="sftp-entry" key={entry.name}><button className="sftp-entry-name" onClick={() => enterEntry(entry)}><span>{entry.type === 'directory' ? '▸' : '•'}</span>{entry.name}</button><small>{entry.type === 'file' ? `${entry.size} B` : entry.type}</small></div>)}</div></section>}</div> : <div className="connect-empty"><strong>Connect to {profile.host}</strong><p>Host key verification runs before terminal and file transfer access.</p></div>}
  </section>;
}

