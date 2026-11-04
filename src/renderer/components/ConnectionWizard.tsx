type Target = 'database' | 'ssh' | 'files';

const targets: { id: Target; icon: string; title: string; detail: string }[] = [
  { id: 'database', icon: 'DB', title: 'Database', detail: 'MySQL, PostgreSQL, SQLite, Redis, and more' },
  { id: 'ssh', icon: '>_', title: 'SSH host', detail: 'Terminal access and linked SFTP files' },
  { id: 'files', icon: '⇄', title: 'File storage', detail: 'SFTP, FTP, FTPS, or AWS S3' },
];

export function ConnectionWizard({ onChoose, onClose }: { onChoose(target: Target): void; onClose(): void }) {
  return <div className="dialog-scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="profile-dialog connection-wizard" role="dialog" aria-modal="true" aria-labelledby="connection-wizard-title">
      <div className="dialog-heading"><div><p className="eyebrow">New connection · Choose a type</p><h2 id="connection-wizard-title">Choose a connection type</h2><p className="dialog-intro">Start with a saved setup or choose the kind of service you want to connect.</p></div><button className="icon-button" aria-label="Close dialog" onClick={onClose}>×</button></div>
      <div className="wizard-target-list">{targets.map((target) => <button className="wizard-target" key={target.id} onClick={() => onChoose(target.id)}><span className="wizard-target-icon">{target.icon}</span><span><strong>{target.title}</strong><small>{target.detail}</small></span><span className="wizard-target-arrow">›</span></button>)}</div>
      <div className="dialog-footer"><span className="field-hint">Reuse a saved setup or begin with a blank profile in the next step.</span><button className="button button-subtle" onClick={onClose}>Cancel</button></div>
    </section>
  </div>;
}
