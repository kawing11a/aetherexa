import { useEffect, useState } from 'react';
import { SshKeyManagerDialog } from './SshKeyManagerDialog.js';

export function SettingsDialog({ onClose, onDirectoryChanged, onOpenUpdates }: { onClose(): void; onDirectoryChanged(): void; onOpenUpdates(): void }) {
  const [directory, setDirectory] = useState('');
  const [pendingDirectory, setPendingDirectory] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [showKeys, setShowKeys] = useState(false);

  useEffect(() => {
    void window.productivityApi.connectionDirectory.get().then((result) => {
      if (result.ok) setDirectory(result.value.directory);
      else setMessage(result.error.message);
    });
  }, []);

  async function chooseDirectory() {
    setMessage('');
    const result = await window.productivityApi.connectionDirectory.choose();
    if (!result.ok) { setMessage(result.error.message); return; }
    if (result.value) setPendingDirectory(result.value);
  }

  async function applyDirectory() {
    if (!pendingDirectory || busy) return;
    const confirmed = window.confirm(`Use this shared connections folder?\n\n${pendingDirectory}\n\nAetherexa will merge profiles by ID. Matching profiles are kept once; conflicting IDs stop the change. The current profiles file will be retained. Passwords and SSH keys remain encrypted in this PC's app data.`);
    if (!confirmed) return;
    setBusy(true);
    const result = await window.productivityApi.connectionDirectory.set({ directory: pendingDirectory });
    setBusy(false);
    setPendingDirectory('');
    if (!result.ok) { setMessage(result.error.message); return; }
    setDirectory(result.value.directory);
    setMessage(`Connection folder changed. ${result.value.profileCount} profile${result.value.profileCount === 1 ? '' : 's'} copied.`);
    onDirectoryChanged();
  }

  return <div className="dialog-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title">
      <div className="dialog-heading"><div><p className="eyebrow">Aetherexa preferences</p><h2 id="settings-dialog-title">Settings</h2></div><button className="icon-button" onClick={onClose} aria-label="Close">×</button></div>
      <div className="settings-section">
        <h3>Connections folder</h3>
        <p className="field-hint">Connection names, hosts, ports, and other profile details are stored in this folder. If it is inside a synced folder, those details may sync. Passwords, passphrases, and SSH private keys remain encrypted in this PC's app data.</p>
        <div className="settings-path" title={directory}>{directory || 'Loading…'}</div>
        <div className="dialog-footer"><button className="button button-secondary" onClick={() => void chooseDirectory()}>Choose folder…</button></div>
        {pendingDirectory && <><div className="settings-path" title={pendingDirectory}>{pendingDirectory}</div><div className="dialog-footer"><button className="button button-secondary" onClick={() => setPendingDirectory('')}>Cancel</button><button className="button button-primary" disabled={busy} onClick={() => void applyDirectory()}>{busy ? 'Moving profiles…' : 'Use this folder'}</button></div></>}
      </div>
      <div className="settings-section"><h3>SSH keys</h3><p className="field-hint">Imported and generated private keys are encrypted in this PC's application data. Only public key details appear in the manager.</p><button className="button button-secondary" onClick={() => setShowKeys(true)}>Manage SSH keys…</button></div>
      {message && <p className="field-hint" role="status">{message}</p>}
      <div className="dialog-footer"><button className="button button-secondary" onClick={onOpenUpdates}>Application updates</button><button className="button button-secondary" onClick={onClose}>Close</button></div>
    </section>
    {showKeys && <SshKeyManagerDialog onClose={() => setShowKeys(false)} />}
  </div>;
}
