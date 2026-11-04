import { useEffect, useState } from 'react';
import type { SshKeyMetadata } from '@shared/profiles';

export function SshKeyManagerDialog({ onClose, onSelect, defaultImportPath, initialLabel }: { onClose(): void; onSelect?(key: SshKeyMetadata): void; defaultImportPath?: string; initialLabel?: string }) {
  const [keys, setKeys] = useState<SshKeyMetadata[]>([]);
  const [label, setLabel] = useState(initialLabel ?? '');
  const [passphrase, setPassphrase] = useState('');
  const [algorithm, setAlgorithm] = useState<'ed25519' | 'rsa'>('ed25519');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = async () => { const result = await window.productivityApi.sshKeys.list(); if (result.ok) setKeys(result.value); else setError(result.error.message); };
  useEffect(() => { void refresh(); }, []);

  async function run<T extends SshKeyMetadata | void>(operation: () => Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }>) {
    setBusy(true); setError('');
    const result = await operation();
    setPassphrase('');
    setBusy(false);
    if (!result.ok) { setError(result.error.message); return; }
    if (result.value && typeof result.value === 'object') setLabel('');
    await refresh();
  }

  async function importKey() { if (!label.trim()) { setError('Enter a label first.'); return; } await run(() => window.productivityApi.sshKeys.import({ label: label.trim(), ...(passphrase ? { passphrase } : {}), ...(defaultImportPath ? { defaultPath: defaultImportPath } : {}) })); }
  async function generateKey() { if (!label.trim()) { setError('Enter a label first.'); return; } await run(() => window.productivityApi.sshKeys.generate({ label: label.trim(), algorithm, ...(passphrase ? { passphrase } : {}) })); }
  async function rename(key: SshKeyMetadata) { const next = window.prompt('Key label', key.label); if (!next?.trim()) return; await run(() => window.productivityApi.sshKeys.rename({ fingerprint: key.fingerprint, label: next.trim() })); }
  async function changePassphrase(key: SshKeyMetadata) { const next = window.prompt('New key passphrase (leave blank to remove the passphrase)'); if (next === null) return; if (!next && !window.confirm('Store this key without a key passphrase? It will still be encrypted in this PC’s protected credential store.')) return; await run(() => window.productivityApi.sshKeys.changePassphrase({ fingerprint: key.fingerprint, passphrase: next })); }
  async function remove(key: SshKeyMetadata) { if (!window.confirm(`Delete “${key.label}” from this PC?`)) return; await run(() => window.productivityApi.sshKeys.remove({ fingerprint: key.fingerprint })); }

  return <div className="dialog-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="profile-dialog key-manager-dialog" role="dialog" aria-modal="true" aria-labelledby="key-manager-title">
      <div className="dialog-heading"><div><p className="eyebrow">Local encrypted storage</p><h2 id="key-manager-title">SSH public key manager</h2></div><button className="icon-button" aria-label="Close" onClick={onClose}>×</button></div>
      <div className="key-create-form">
        <label className="field"><span>Key label</span><input maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Production laptop" /></label>
        <label className="field"><span>Generate algorithm</span><select value={algorithm} onChange={(event) => setAlgorithm(event.target.value as typeof algorithm)}><option value="ed25519">Ed25519</option><option value="rsa">RSA 4096</option></select></label>
        <label className="field"><span>Key passphrase <em>Optional</em></span><input type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></label>
        <div className="key-manager-actions"><button className="button button-secondary" disabled={busy || !label.trim()} onClick={() => void importKey()}>Import private key…</button><button className="button button-primary" disabled={busy || !label.trim()} onClick={() => void generateKey()}>Generate key</button></div>
      </div>
      {error && <div className="workspace-error" role="alert">{error}</div>}
      <div className="key-list">{keys.length === 0 ? <p className="field-hint">No managed keys yet. Import an existing private key or generate a new pair.</p> : keys.map((key) => <article className="key-card" key={key.fingerprint}>
        <div className="key-card-heading"><div><strong>{key.label}</strong><small>{key.algorithm.toUpperCase()} · {key.fingerprint}</small></div><div className="key-manager-actions"><button className="button button-subtle button-small" onClick={() => void rename(key)}>Rename</button><button className="button button-subtle button-small" onClick={() => void changePassphrase(key)}>Change passphrase</button></div></div>
        <code>{key.publicKey}</code>
        <div className="key-manager-actions"><button className="button button-secondary button-small" onClick={() => void navigator.clipboard.writeText(key.publicKey)}>Copy public key</button><button className="button button-secondary button-small" onClick={() => void window.productivityApi.sshKeys.exportPublic({ fingerprint: key.fingerprint })}>Export .pub</button>{onSelect && <button className="button button-primary button-small" onClick={() => onSelect(key)}>Use this key</button>}<button className="button button-subtle button-small" onClick={() => void remove(key)}>Delete</button></div>
      </article>)}</div>
      <div className="dialog-footer"><button className="button button-secondary" onClick={onClose}>Close</button></div>
    </section>
  </div>;
}
