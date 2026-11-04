import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { ProfileSaveInput } from '@shared/contracts';
import type { ConnectionCatalog, ConnectionProfile, DatabaseEngine } from '@shared/profiles';
import type { SshKeyMetadata } from '@shared/profiles';
import { SshKeyManagerDialog } from './SshKeyManagerDialog.js';
import { ConnectionGroupField } from './ConnectionGroupField.js';

type ProfileKind = 'database' | 'ssh';
type AuthMode = 'password' | 'private-key-file' | 'agent';

type ProfileDialogProps = {
  kind: ProfileKind;
  profile?: ConnectionProfile;
  onClose(): void;
  onSave(input: ProfileSaveInput): Promise<boolean>;
  visible?: boolean;
  groups?: string[];
  templates?: ConnectionCatalog['templates'];
  reusableValues?: ConnectionCatalog['reusableValues'];
  profiles?: ConnectionProfile[];
  onBack?(): void;
  onSaveTemplate?(template: ConnectionCatalog['templates'][number]): Promise<boolean>;
  onCreateGroup?(name: string): Promise<boolean>;
};

const engines: { value: DatabaseEngine; label: string; defaultPort: number }[] = [
  { value: 'mysql', label: 'MySQL / MariaDB', defaultPort: 3306 },
  { value: 'postgres', label: 'PostgreSQL', defaultPort: 5432 },
  { value: 'sqlserver', label: 'SQL Server', defaultPort: 1433 },
  { value: 'oracle', label: 'Oracle', defaultPort: 1521 },
  { value: 'sqlite', label: 'SQLite', defaultPort: 0 },
  { value: 'mongodb', label: 'MongoDB', defaultPort: 27017 },
  { value: 'redis', label: 'Redis', defaultPort: 6379 },
  { value: 'memcached', label: 'Memcached', defaultPort: 11211 },
];

export function ProfileDialog({ kind: initialKind, profile, onClose, onSave, visible = true, groups = [], templates = [], reusableValues = [], profiles = [], onBack, onSaveTemplate, onCreateGroup }: ProfileDialogProps) {
  const [kind, setKind] = useState<ProfileKind>(profile?.kind === 'ssh' ? 'ssh' : profile?.kind === 'database' ? 'database' : initialKind);
  const [engine, setEngine] = useState<DatabaseEngine>(profile?.kind === 'database' ? profile.engine : 'postgres');
  const [name, setName] = useState(profile?.name ?? '');
  const [group, setGroup] = useState(profile?.groupId ?? '');
  const [host, setHost] = useState(profile?.kind === 'ssh' ? profile.host : String(profile?.kind === 'database' ? profile.options.host ?? '' : ''));
  const [port, setPort] = useState(String(profile?.kind === 'ssh' ? profile.port : profile?.kind === 'database' ? profile.options.port ?? (profile.engine === 'postgres' ? 5432 : 0) : 5432));
  const [database, setDatabase] = useState(String(profile?.kind === 'database' ? profile.engine === 'sqlite' ? profile.options.path ?? '' : profile.options.database ?? '' : ''));
  const [username, setUsername] = useState(profile?.kind === 'ssh' ? profile.username : String(profile?.kind === 'database' ? profile.options.username ?? '' : ''));
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [secure, setSecure] = useState(profile?.kind === 'database' ? Boolean(profile.options.tls ?? profile.engine !== 'memcached') : true);
  const [authMode, setAuthMode] = useState<AuthMode>(profile?.kind === 'ssh' ? profile.authentication : 'password');
  const [privateKeyPath, setPrivateKeyPath] = useState(profile?.kind === 'ssh' ? profile.privateKeyPath ?? '' : '');
  const [keyFingerprint, setKeyFingerprint] = useState(profile?.kind === 'ssh' ? profile.keyFingerprint ?? '' : '');
  const [keys, setKeys] = useState<SshKeyMetadata[]>([]);
  const [showKeyManager, setShowKeyManager] = useState(false);
  const [saving, setSaving] = useState(false);
  const isSqlite = kind === 'database' && engine === 'sqlite';
  useEffect(() => { if (!profile) setKind(initialKind); }, [initialKind, profile]);
  useEffect(() => { if (kind === 'ssh') void window.productivityApi.sshKeys.list().then((result) => { if (result.ok) setKeys(result.value); }); }, [kind]);

  function selectEngine(nextEngine: DatabaseEngine) {
    setEngine(nextEngine);
    const target = engines.find((item) => item.value === nextEngine);
    if (target && target.defaultPort > 0) setPort(String(target.defaultPort));
    setSecure(nextEngine !== 'memcached');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    const id = profile?.id ?? crypto.randomUUID();
    const groupId = group.trim() || null;
    const secrets: Record<string, string> = {};
    if (password.trim()) secrets.password = password;
    if (passphrase.trim() && !(kind === 'ssh' && keyFingerprint)) secrets.passphrase = passphrase;

    const savedProfile: ProfileSaveInput['profile'] = kind === 'database'
      ? {
          kind: 'database',
          id,
          name: name.trim(),
          groupId,
          ...(profile?.secretRevision ? { secretRevision: profile.secretRevision } : {}),
          engine,
          options: isSqlite
            ? { path: database.trim(), readOnly: false }
            : {
                host: host.trim(),
                port: Number(port),
                database: database.trim(),
                username: username.trim(),
                tls: secure,
              },
        }
      : {
          kind: 'ssh',
          id,
          name: name.trim(),
          groupId,
          ...(profile?.secretRevision && !(authMode === 'private-key-file' && keyFingerprint) ? { secretRevision: profile.secretRevision } : {}),
          host: host.trim(),
          port: Number(port),
          username: username.trim(),
          authentication: authMode,
          ...(authMode === 'private-key-file' && keyFingerprint ? { keyFingerprint } : {}),
          ...(authMode === 'private-key-file' && !keyFingerprint && privateKeyPath.trim() ? { privateKeyPath: privateKeyPath.trim() } : {}),
        };

    const saved = await onSave({ profile: savedProfile, ...(Object.keys(secrets).length ? { secrets } : {}) });
    setSaving(false);
    if (saved) onClose();
  }

  async function useTemplate(id: string) {
    const template = templates.find((item) => item.id === id && item.target === (kind === 'ssh' ? 'ssh' : `database:${engine}`));
    if (!template) return;
    const fields = template.fields;
    if (kind === 'database') {
      const targetEngine = template.target.slice('database:'.length) as DatabaseEngine;
      setEngine(targetEngine);
      setHost(String(fields.host ?? '')); setPort(String(fields.port ?? engines.find((item) => item.value === targetEngine)?.defaultPort ?? 0));
      setDatabase(String(fields.database ?? fields.path ?? '')); setUsername(String(fields.username ?? '')); setSecure(Boolean(fields.tls ?? true));
    } else { setHost(String(fields.host ?? '')); setPort(String(fields.port ?? 22)); setUsername(String(fields.username ?? '')); }
  }

  function useSavedProfile(id: string) {
    const source = profiles.find((item) => item.id === id && (kind === 'ssh' ? item.kind === 'ssh' : item.kind === 'database' && item.engine === engine));
    if (!source) return;
    setGroup(source.groupId ?? '');
    if (source.kind === 'ssh') { setHost(source.host); setPort(String(source.port)); setUsername(source.username); setAuthMode('password'); setPrivateKeyPath(''); setKeyFingerprint(''); setPassword(''); setPassphrase(''); }
    else if (source.kind === 'database') {
      setHost(String(source.options.host ?? '')); setPort(String(source.options.port ?? 0)); setDatabase(String(source.options.path ?? source.options.database ?? ''));
      setUsername(String(source.options.username ?? '')); setSecure(Boolean(source.options.tls ?? true)); setPassword(''); setPassphrase('');
    }
  }

  async function saveTemplate() {
    const templateName = window.prompt('Name this connection template:')?.trim();
    if (!templateName || !onSaveTemplate) return;
    const target = kind === 'ssh' ? 'ssh' : `database:${engine}` as const;
    const fields: Record<string, string | number | boolean> = kind === 'ssh' ? { host: host.trim(), port: Number(port), username: username.trim() } : isSqlite ? { path: database.trim() } : { host: host.trim(), port: Number(port), database: database.trim(), username: username.trim(), tls: secure };
    await onSaveTemplate({ id: crypto.randomUUID(), name: templateName, target, fields });
  }

  return (
    <>
    <div className="dialog-scrim" style={{ display: visible ? undefined : 'none' }} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-dialog-title">
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">{onBack && !profile ? 'New connection · Step 2 of 2' : 'Connection profile'}</p>
            <h2 id="profile-dialog-title">{profile ? 'Edit' : 'Add'} {kind === 'database' ? 'database' : 'SSH'} connection</h2>
          </div>
          <button className="icon-button" aria-label="Close dialog" onClick={onClose}>×</button>
        </div>

        <form onSubmit={submit}>
          {!profile && !onBack && <div className="dialog-kind-switch" aria-label="Profile type">
            <button type="button" className={kind === 'database' ? 'selected' : ''} onClick={() => setKind('database')}>
              Database
            </button>
            <button type="button" className={kind === 'ssh' ? 'selected' : ''} onClick={() => setKind('ssh')}>
              SSH host
            </button>
          </div>}

          {!profile && <div className="form-grid wizard-reuse-row">
            <label className="field field-wide"><span>Start from a saved connection</span><select defaultValue="" onChange={(event) => useSavedProfile(event.target.value)}><option value="">Choose a compatible profile…</option>{profiles.filter((item) => kind === 'ssh' ? item.kind === 'ssh' : item.kind === 'database' && item.engine === engine).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label className="field field-wide"><span>Or start from a template</span><select defaultValue="" onChange={(event) => void useTemplate(event.target.value)}><option value="">Choose a saved template…</option>{templates.filter((item) => item.target === (kind === 'ssh' ? 'ssh' : `database:${engine}`)).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          </div>}

          <div className="form-grid">
            <label className="field field-wide">
              <span>Connection name</span>
              <input autoFocus required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="Production database" />
            </label>
            <ConnectionGroupField value={group} groups={groups} onChange={setGroup} onCreate={onCreateGroup ?? (async (name) => { const result = await window.productivityApi.connectionCatalog.change({ type: 'create-group', name }); return result.ok; })} />

            {kind === 'database' && (
              <label className="field field-wide">
                <span>Database engine</span>
                <select value={engine} onChange={(event) => selectEngine(event.target.value as DatabaseEngine)}>
                  {engines.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </label>
            )}

            {isSqlite ? (
              <label className="field field-wide">
                <span>Database file path</span>
                <input required list={`reusable-${kind}-${engine}-path`} value={database} onChange={(event) => setDatabase(event.target.value)} placeholder="C:\\data\\app.db" />
              </label>
            ) : (
              <>
                <label className="field field-wide">
                  <span>Host</span>
                  <input required list={`reusable-${kind}-${kind === 'database' ? engine : 'ssh'}-host`} value={host} onChange={(event) => setHost(event.target.value)} placeholder="db.example.com" />
                </label>
                <label className="field">
                  <span>Port</span>
                  <input required list={`reusable-${kind}-${kind === 'database' ? engine : 'ssh'}-port`} inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value)} />
                </label>
                <label className="field">
                  <span>{kind === 'database' && engine === 'redis' ? 'Database index' : 'Database / service'} <em>Optional</em></span>
                  <input list={`reusable-${kind}-${kind === 'database' ? engine : 'ssh'}-database`} value={database} onChange={(event) => setDatabase(event.target.value)} placeholder={kind === 'database' && engine === 'redis' ? '0' : 'app'} />
                </label>
                <label className="field field-wide">
                  <span>Username <em>{kind === 'database' && ['mysql', 'postgres', 'sqlserver', 'oracle'].includes(engine) ? 'Required' : 'Optional'}</em></span>
                  <input list={`reusable-${kind}-${kind === 'database' ? engine : 'ssh'}-username`} autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Username" />
                </label>

                {kind === 'ssh' ? (
                  <>
                    <label className="field field-wide">
                      <span>Authentication</span>
                      <select value={authMode} onChange={(event) => setAuthMode(event.target.value as AuthMode)}>
                        <option value="password">Password</option>
                        <option value="private-key-file">Public Key</option>
                        <option value="agent">SSH Agent</option>
                      </select>
                    </label>
                    {authMode === 'private-key-file' && (
                      <>
                        {privateKeyPath && !keyFingerprint && <div className="field field-wide"><span>Legacy private key file</span><code>{privateKeyPath}</code><small>This existing profile will keep working. Import the key to stop using a file path.</small></div>}
                        <label className="field field-wide">
                          <span>Managed SSH key</span>
                          <select required={!privateKeyPath} value={keyFingerprint} onChange={(event) => setKeyFingerprint(event.target.value)}>
                            <option value="">{privateKeyPath ? 'Keep legacy key file' : 'Choose a key…'}</option>
                            {keys.map((key) => <option key={key.fingerprint} value={key.fingerprint}>{key.label} · {key.algorithm}</option>)}
                          </select>
                        </label>
                        <div className="dialog-footer field-wide"><button type="button" className="button button-secondary" onClick={() => setShowKeyManager(true)}>{privateKeyPath && !keyFingerprint ? 'Import key into manager…' : 'Manage keys…'}</button></div>
                        {!keyFingerprint && !privateKeyPath && <p className="field-hint field-wide">Add a key in the manager, then select it here.</p>}
                      </>
                    )}
                  </>
                ) : (
                  <label className="field field-wide toggle-field">
                    <span><strong>Use TLS</strong><small>{engine === 'memcached' ? 'The selected Memcached client does not support TLS.' : 'Encrypt the database connection when supported.'}</small></span>
                    <input type="checkbox" checked={secure} disabled={engine === 'memcached'} onChange={(event) => setSecure(event.target.checked)} />
                  </label>
                )}

                {(kind === 'database' || authMode === 'password') && (
                  <label className="field field-wide">
                    <span>Password <em>{profile ? 'Leave blank to keep saved password' : 'Optional'}</em></span>
                    <input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Stored in Windows-protected local storage" />
                  </label>
                )}
              </>
            )}
          </div>

          <p className="dialog-security-note"><span aria-hidden="true">▣</span> Credentials are encrypted locally and never included in profile exports.</p>
          <div className="dialog-footer">
            {!profile && onSaveTemplate && <button type="button" className="button button-secondary" onClick={() => void saveTemplate()}>Save as template</button>}
            {onBack && !profile && <button type="button" className="button button-subtle" onClick={onBack}>Back</button>}
            <button type="button" className="button button-subtle" onClick={onClose}>Cancel</button>
            <button type="submit" className="button button-primary" disabled={saving || !name.trim() || (!isSqlite && !host.trim()) || (kind === 'ssh' && !username.trim()) || (kind === 'database' && ['mysql', 'postgres', 'sqlserver', 'oracle'].includes(engine) && !username.trim())}>
              {saving ? 'Saving…' : profile ? 'Save changes' : 'Save connection'}
            </button>
          </div>
        </form>
        <datalist id={`reusable-${kind}-${kind === 'database' ? engine : 'ssh'}-host`}>{reusableValues.filter((item) => item.field === 'host' && item.target === (kind === 'ssh' ? 'ssh' : `database:${engine}`)).map((item, index) => <option key={`${item.target}-${index}`} value={String(item.value)} />)}</datalist>
        {(['database', 'username', 'port', 'path'] as const).map((field) => <datalist id={`reusable-${kind}-${kind === 'database' ? engine : 'ssh'}-${field}`} key={field}>{reusableValues.filter((item) => item.field === field && item.target === (kind === 'ssh' ? 'ssh' : `database:${engine}`)).map((item, index) => <option key={`${item.target}-${index}`} value={String(item.value)} />)}</datalist>)}
      </section>
    </div>
    {showKeyManager && <SshKeyManagerDialog initialLabel={name} defaultImportPath={privateKeyPath || undefined} onClose={() => setShowKeyManager(false)} onSelect={(key) => { setKeys((current) => current.some((item) => item.fingerprint === key.fingerprint) ? current.map((item) => item.fingerprint === key.fingerprint ? key : item) : [...current, key]); setKeyFingerprint(key.fingerprint); setPrivateKeyPath(''); setShowKeyManager(false); }} />}
    </>
  );
}
