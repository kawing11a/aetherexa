import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { ProfileSaveInput } from '@shared/contracts';
import type { ConnectionCatalog, ConnectionProfile, FileTransferProfile, SshKeyMetadata } from '@shared/profiles';
import { SshKeyManagerDialog } from './SshKeyManagerDialog.js';
import { ConnectionGroupField } from './ConnectionGroupField.js';

type Protocol = FileTransferProfile['protocol'];
type RemoteProtocol = Exclude<Protocol, 's3'>;
const ports: Record<Protocol, number> = { sftp: 22, ftp: 21, 'ftps-explicit': 21, 'ftps-implicit': 990, s3: 443 };

export function FileTransferProfileDialog({ profile, onClose, onSave, visible = true, initialProtocol = 'sftp', stepLabel = 'Step 2 of 2', groups = [], templates = [], reusableValues = [], profiles = [], onBack, onSaveTemplate, onCreateGroup }: { profile?: ConnectionProfile; onClose(): void; onSave(input: ProfileSaveInput): Promise<boolean>; visible?: boolean; initialProtocol?: Protocol; stepLabel?: string; groups?: string[]; templates?: ConnectionCatalog['templates']; reusableValues?: ConnectionCatalog['reusableValues']; profiles?: ConnectionProfile[]; onBack?(): void; onSaveTemplate?(template: ConnectionCatalog['templates'][number]): Promise<boolean>; onCreateGroup?(name: string): Promise<boolean> }) {
  const existing = profile?.kind === 'file-transfer' ? profile : undefined;
  const remote = existing && existing.protocol !== 's3' ? existing : undefined;
  const s3 = existing?.protocol === 's3' ? existing : undefined;
  const [protocol, setProtocol] = useState<Protocol>(existing?.protocol ?? initialProtocol);
  const [name, setName] = useState(existing?.name ?? '');
  const [group, setGroup] = useState(existing?.groupId ?? '');
  const [host, setHost] = useState(remote?.host ?? '');
  const [port, setPort] = useState(String(remote?.port ?? ports.sftp));
  const [username, setUsername] = useState(remote?.username ?? '');
  const [authentication, setAuthentication] = useState<'password' | 'key-manager' | 'agent'>(remote?.authentication ?? 'password');
  const [fingerprint, setFingerprint] = useState(remote?.keyFingerprint ?? '');
  const [bucket, setBucket] = useState(s3?.bucket ?? '');
  const [region, setRegion] = useState(s3?.region ?? 'us-east-1');
  const [credentialMode, setCredentialMode] = useState<'default-chain' | 'static'>(s3?.credentialMode ?? 'default-chain');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [password, setPassword] = useState('');
  const [keys, setKeys] = useState<SshKeyMetadata[]>([]);
  const [showKeys, setShowKeys] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => { void window.productivityApi.sshKeys.list().then((result) => { if (result.ok) setKeys(result.value); }); }, []);
  function changeProtocol(value: Protocol) { setProtocol(value); setPort(String(ports[value])); if (value !== 'sftp') setAuthentication('password'); if (value === 's3') setCredentialMode('default-chain'); }
  function useTemplate(id: string) {
    const template = templates.find((item) => item.id === id && item.target === `file-transfer:${protocol}`);
    if (!template) return;
    const fields = template.fields;
    if (protocol === 's3') { setBucket(String(fields.bucket ?? '')); setRegion(String(fields.region ?? 'us-east-1')); }
    else { setHost(String(fields.host ?? '')); setPort(String(fields.port ?? ports[protocol])); setUsername(String(fields.username ?? '')); }
  }
  function useSavedProfile(id: string) {
    const source = profiles.find((item) => item.id === id && item.kind === 'file-transfer' && item.protocol === protocol);
    if (!source || source.kind !== 'file-transfer') return;
    setGroup(source.groupId ?? '');
    if (source.protocol === 's3') { setBucket(source.bucket); setRegion(source.region); setCredentialMode('default-chain'); setAccessKeyId(''); setSecretAccessKey(''); }
    else { setHost(source.host); setPort(String(source.port)); setUsername(source.username); setAuthentication('password'); setFingerprint(''); setPassword(''); }
  }
  async function saveTemplate() {
    const templateName = window.prompt('Name this connection template:')?.trim();
    if (!templateName || !onSaveTemplate) return;
    const target = `file-transfer:${protocol}` as const;
    const fields: Record<string, string | number | boolean> = protocol === 's3' ? { bucket: bucket.trim(), region: region.trim() } : { host: host.trim(), port: Number(port), username: username.trim() };
    await onSaveTemplate({ id: crypto.randomUUID(), name: templateName, target, fields });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (protocol === 's3' && credentialMode === 'static' && Boolean(accessKeyId) !== Boolean(secretAccessKey)) return;
    setSaving(true);
    const id = existing?.id ?? crypto.randomUUID();
    let saved: ProfileSaveInput['profile'];
    let secrets: Record<string, string> | undefined;
    if (protocol === 's3') {
      saved = { kind: 'file-transfer', id, name: name.trim(), groupId: group.trim() || null, ...(s3?.secretRevision && credentialMode === 'static' && !accessKeyId && !secretAccessKey ? { secretRevision: s3.secretRevision } : {}), protocol, bucket: bucket.trim(), region: region.trim(), credentialMode };
      if (credentialMode === 'static' && accessKeyId && secretAccessKey) secrets = { accessKeyId, secretAccessKey };
    } else {
      saved = { kind: 'file-transfer', id, name: name.trim(), groupId: group.trim() || null, ...(remote?.secretRevision && authentication === 'password' && !password ? { secretRevision: remote.secretRevision } : {}), protocol: protocol as RemoteProtocol, host: host.trim(), port: Number(port), username: username.trim(), authentication, ...(authentication === 'key-manager' && fingerprint ? { keyFingerprint: fingerprint } : {}) };
      if (authentication === 'password' && password) secrets = { password };
    }
    const ok = await onSave({ profile: saved, ...(secrets ? { secrets } : {}) });
    setPassword(''); setAccessKeyId(''); setSecretAccessKey(''); setSaving(false); if (ok) onClose();
  }

  const secureProtocol = protocol === 'ftps-explicit' || protocol === 'ftps-implicit';
  const validTarget = protocol === 's3' ? Boolean(bucket.trim() && region.trim()) : Boolean(host.trim() && username.trim());
  const missingStaticSecret = protocol === 's3' && credentialMode === 'static' && !s3?.secretRevision && (!accessKeyId || !secretAccessKey);
  return <>
    <div className="dialog-scrim" style={{ display: visible ? undefined : 'none' }} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="file-profile-title">
        <div className="dialog-heading"><div><p className="eyebrow">{onBack && !existing ? `New connection · ${stepLabel}` : 'Independent file connection'}</p><h2 id="file-profile-title">{existing ? 'Edit' : 'Add'} Files profile</h2></div><button className="icon-button" aria-label="Close" onClick={onClose}>×</button></div>
        <form onSubmit={(event) => void submit(event)}><div className="form-grid">
          {!existing && <>
            <label className="field field-wide"><span>Start from a saved connection</span><select defaultValue="" onChange={(event) => useSavedProfile(event.target.value)}><option value="">Choose a compatible profile…</option>{profiles.filter((item) => item.kind === 'file-transfer' && item.protocol === protocol).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label className="field field-wide"><span>Or start from a template</span><select defaultValue="" onChange={(event) => useTemplate(event.target.value)}><option value="">Choose a saved template…</option>{templates.filter((item) => item.target === `file-transfer:${protocol}`).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          </>}
          <label className="field field-wide"><span>Connection name</span><input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="Production files" /></label>
          <ConnectionGroupField value={group} groups={groups} onChange={setGroup} onCreate={onCreateGroup ?? (async (name) => { const result = await window.productivityApi.connectionCatalog.change({ type: 'create-group', name }); return result.ok; })} />
          {!onBack && <label className="field field-wide"><span>Protocol</span><select value={protocol} onChange={(event) => changeProtocol(event.target.value as Protocol)}><option value="sftp">SFTP</option><option value="ftp">FTP (unencrypted)</option><option value="ftps-explicit">FTPS (explicit TLS)</option><option value="ftps-implicit">FTPS (implicit TLS)</option><option value="s3">AWS S3</option></select></label>}
          {protocol === 's3' ? <>
            <label className="field field-wide"><span>Bucket name</span><input list={`reusable-files-${protocol}-bucket`} required maxLength={63} value={bucket} onChange={(event) => setBucket(event.target.value.toLowerCase())} placeholder="company-production-files" /></label>
            <label className="field field-wide"><span>AWS region</span><input list={`reusable-files-${protocol}-region`} required maxLength={64} value={region} onChange={(event) => setRegion(event.target.value)} placeholder="us-east-1" /></label>
            <label className="field field-wide"><span>AWS credentials</span><select value={credentialMode} onChange={(event) => setCredentialMode(event.target.value as typeof credentialMode)}><option value="default-chain">Default AWS credential chain</option><option value="static">Static access key</option></select></label>
            {credentialMode === 'static' && <>
              <label className="field field-wide"><span>Access key ID <em>{s3 ? 'Leave both fields blank to keep saved keys' : ''}</em></span><input autoComplete="off" value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} /></label>
              <label className="field field-wide"><span>Secret access key</span><input type="password" autoComplete="new-password" value={secretAccessKey} onChange={(event) => setSecretAccessKey(event.target.value)} /></label>
              {Boolean(accessKeyId) !== Boolean(secretAccessKey) && <p className="field-hint field-wide">Enter both static key fields together.</p>}
            </>}
            <p className="field-hint field-wide">The default chain uses AWS environment credentials, shared config, IAM Identity Center, or an instance role. S3 folders are virtual prefixes.</p>
          </> : <>
            <label className="field field-wide"><span>Host</span><input list={`reusable-files-${protocol}-host`} required maxLength={255} value={host} onChange={(event) => setHost(event.target.value)} placeholder="files.example.com" /></label>
            <label className="field"><span>Port</span><input list={`reusable-files-${protocol}-port`} required inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value)} /></label>
            <label className="field"><span>Username</span><input list={`reusable-files-${protocol}-username`} required maxLength={128} autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
            {protocol === 'sftp' && <label className="field field-wide"><span>Authentication</span><select value={authentication} onChange={(event) => setAuthentication(event.target.value as typeof authentication)}><option value="password">Password</option><option value="key-manager">Managed public key</option><option value="agent">SSH Agent</option></select></label>}
            {protocol === 'sftp' && authentication === 'key-manager' && <><label className="field field-wide"><span>SSH key</span><select required value={fingerprint} onChange={(event) => setFingerprint(event.target.value)}><option value="">Choose a key…</option>{keys.map((key) => <option key={key.fingerprint} value={key.fingerprint}>{key.label} · {key.algorithm}</option>)}</select></label><div className="dialog-footer field-wide"><button type="button" className="button button-secondary" onClick={() => setShowKeys(true)}>Manage keys…</button></div></>}
            {authentication === 'password' && <label className="field field-wide"><span>Password <em>{existing ? 'Leave blank to keep saved password' : 'Stored encrypted on this PC'}</em></span><input type="password" required={!existing} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>}
            {secureProtocol && <p className="field-hint field-wide">TLS certificate and hostname verification are always enabled.</p>}
            {protocol === 'ftp' && <p className="field-hint field-wide">FTP sends credentials and file contents without encryption. A warning appears before connecting.</p>}
            {protocol === 'sftp' && <p className="field-hint field-wide">SFTP verifies the server host key before file access. No SSH terminal profile is needed.</p>}
          </>}
        </div><p className="dialog-security-note">Passwords and static AWS secrets stay in encrypted local storage.</p><div className="dialog-footer">{!existing && onSaveTemplate && <button type="button" className="button button-secondary" onClick={() => void saveTemplate()}>Save as template</button>}{onBack && !existing && <button type="button" className="button button-subtle" onClick={onBack}>Back</button>}<button type="button" className="button button-subtle" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={saving || !name.trim() || !validTarget || (protocol === 'sftp' && authentication === 'key-manager' && !fingerprint) || missingStaticSecret || (protocol === 's3' && credentialMode === 'static' && Boolean(accessKeyId) !== Boolean(secretAccessKey))}>{saving ? 'Saving…' : existing ? 'Save changes' : 'Save connection'}</button></div></form>
      </section>
      {(['host', 'port', 'username', 'bucket', 'region'] as const).map((field) => <datalist id={`reusable-files-${protocol}-${field}`} key={field}>{reusableValues.filter((item) => item.target === `file-transfer:${protocol}` && item.field === field).map((item, index) => <option key={`${item.target}-${index}`} value={String(item.value)} />)}</datalist>)}
    </div>
    {showKeys && <SshKeyManagerDialog onClose={() => setShowKeys(false)} onSelect={(key) => { setKeys((current) => current.some((item) => item.fingerprint === key.fingerprint) ? current.map((item) => item.fingerprint === key.fingerprint ? key : item) : [...current, key]); setFingerprint(key.fingerprint); setShowKeys(false); }} />}
  </>;
}
