import type { FileTransferProfile } from '@shared/profiles';

type Protocol = FileTransferProfile['protocol'];
const protocols: { value: Protocol; label: string; detail: string }[] = [
  { value: 'sftp', label: 'SFTP', detail: 'Secure file transfer over SSH' },
  { value: 'ftp', label: 'FTP', detail: 'Unencrypted file transfer' },
  { value: 'ftps-explicit', label: 'FTPS · explicit TLS', detail: 'FTP upgraded to TLS on port 21' },
  { value: 'ftps-implicit', label: 'FTPS · implicit TLS', detail: 'TLS from connection start, commonly port 990' },
  { value: 's3', label: 'AWS S3', detail: 'Bucket access using default chain or static keys' },
];

export function FileTypeWizard({ onChoose, onBack, onClose }: { onChoose(protocol: Protocol): void; onBack(): void; onClose(): void }) {
  return <div className="dialog-scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="profile-dialog connection-wizard" role="dialog" aria-modal="true" aria-labelledby="file-type-title">
      <div className="dialog-heading"><div><p className="eyebrow">New connection · Step 2 of 3</p><h2 id="file-type-title">Choose a data protocol</h2><p className="dialog-intro">Each transfer mode keeps its own saved setup and draft fields.</p></div><button className="icon-button" aria-label="Close dialog" onClick={onClose}>×</button></div>
      <div className="wizard-target-list">{protocols.map((protocol) => <button className="wizard-target" key={protocol.value} onClick={() => onChoose(protocol.value)}><span className="wizard-target-icon">{protocol.value === 's3' ? 'S3' : '⇄'}</span><span><strong>{protocol.label}</strong><small>{protocol.detail}</small></span><span className="wizard-target-arrow">›</span></button>)}</div>
      <div className="dialog-footer"><button className="button button-subtle" onClick={onBack}>Back</button><button className="button button-subtle" onClick={onClose}>Cancel</button></div>
    </section>
  </div>;
}
