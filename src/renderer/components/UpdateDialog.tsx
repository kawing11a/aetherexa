import type { UpdateStatus } from '@shared/contracts';

export function UpdateDialog({
  currentVersion,
  status,
  onCheck,
  onInstall,
  onClose,
}: {
  currentVersion: string;
  status: UpdateStatus;
  onCheck(): void;
  onInstall(): void;
  onClose(): void;
}) {
  const busy = status.state === 'checking' || status.state === 'downloading';

  return (
    <div className="dialog-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="profile-dialog update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title">
        <div className="dialog-heading">
          <div><p className="eyebrow">Aetherexa updates</p><h2 id="update-dialog-title">Application update</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <p className="update-current-version">Installed version: <strong>{currentVersion || '0.1.0'}</strong></p>
        <div className={`update-state update-state-${status.state}`} role="status" aria-live="polite">
          {busy && <span className="loading-orbit" aria-hidden="true" />}
          <p>{status.message}</p>
        </div>
        {status.state === 'unsupported' && <p className="field-hint">Automatic updates apply to the Aetherexa Setup.exe installation. MSI installs are upgraded through Windows Installer.</p>}
        <div className="dialog-footer update-check-actions">
          {status.state === 'ready' ? (
            <>
              <button className="button button-secondary" onClick={onClose}>Later</button>
              <button className="button button-primary" onClick={onInstall}>Restart now to update</button>
            </>
          ) : status.state === 'unsupported' ? (
            <button className="button button-secondary" onClick={onClose}>Close</button>
          ) : (
            <>
              <button className="button button-secondary" onClick={onClose} disabled={busy}>Close</button>
              <button className="button button-primary" onClick={onCheck} disabled={busy}>{busy ? 'Working…' : 'Check for updates'}</button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
