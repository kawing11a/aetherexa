import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConnectionCatalog, ConnectionProfile, FileTransferProfile } from '@shared/profiles';
import type { ProfileSaveInput, UpdateStatus } from '@shared/contracts';
import { WorkspaceRouter } from '@renderer/workspaces/WorkspaceRouter.js';
import { ConnectionSidebar } from './ConnectionSidebar.js';
import { CommandSearch } from './CommandSearch.js';
import { ProfileDialog } from './ProfileDialog.js';
import { WorkspaceTabs } from './WorkspaceTabs.js';
import { UpdateDialog } from './UpdateDialog.js';
import { SettingsDialog } from './SettingsDialog.js';
import { FileTransferProfileDialog } from './FileTransferProfileDialog.js';
import aetherexaIcon from '@renderer/assets/aetherexa.png';
import type { WorkspaceTab } from './WorkspaceTabs.js';
import { ConnectionWizard } from './ConnectionWizard.js';
import { GroupManagerDialog } from './GroupManagerDialog.js';
import { FileTypeWizard } from './FileTypeWizard.js';

type ProfileKind = 'database' | 'ssh';

export function AppShell() {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [catalog, setCatalog] = useState<ConnectionCatalog>({ groups: [], templates: [], reusableValues: [] });
  const [profileVersions, setProfileVersions] = useState<Record<string, number>>({});
  const [openProfileIds, setOpenProfileIds] = useState<string[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [dialogKind, setDialogKind] = useState<ProfileKind | null>(null);
  const [editingProfile, setEditingProfile] = useState<ConnectionProfile | undefined>();
  const [fileDialogProfile, setFileDialogProfile] = useState<ConnectionProfile | undefined>();
  const [showFileDialog, setShowFileDialog] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState('');
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: 'idle', message: 'Updates have not been checked yet.' });
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showNewConnection, setShowNewConnection] = useState(false);
  const [wizardTarget, setWizardTarget] = useState<'database' | 'ssh' | 'files' | null>(null);
  const [wizardFileProtocol, setWizardFileProtocol] = useState<FileTransferProfile['protocol'] | null>(null);
  const [choosingFileProtocol, setChoosingFileProtocol] = useState(false);
  const [showGroups, setShowGroups] = useState(false);

  const refreshCatalog = useCallback(async () => {
    const result = await window.productivityApi.connectionCatalog.load();
    if (result.ok) setCatalog(result.value);
  }, []);

  const refreshProfiles = useCallback(async () => {
    const result = await window.productivityApi.profiles.list();
    if (result.ok) {
      setProfiles(result.value);
      setError(null);
      return;
    }
    setError(result.error.message);
  }, []);

  useEffect(() => {
    const unsubscribeUpdateStatus = window.productivityApi.app.onUpdateStatus(setUpdateStatus);
    void Promise.all([
      refreshProfiles(),
      refreshCatalog(),
      window.productivityApi.app.getVersion().then((result) => {
        if (result.ok) setVersion(result.value);
      }),
      window.productivityApi.app.getUpdateStatus().then((result) => {
        if (result.ok) setUpdateStatus(result.value);
      }),
    ]).finally(() => setLoading(false));
    return unsubscribeUpdateStatus;
  }, [refreshProfiles, refreshCatalog]);

  const tabs = useMemo<WorkspaceTab[]>(() => openProfileIds.flatMap((id) => {
    const profile = profiles.find((item) => item.id === id);
    return profile ? [{ id, title: profile.name, kind: profile.kind }] : [];
  }), [openProfileIds, profiles]);
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null;

  function openProfileDialog(kind: ProfileKind, profile?: ConnectionProfile) {
    if (!profile) { setShowNewConnection(true); setWizardTarget(null); return; }
    if (profile?.kind === 'file-transfer') { setFileDialogProfile(profile); setShowFileDialog(true); return; }
    setEditingProfile(profile);
    setDialogKind(kind);
  }

  function editActiveProfile() {
    if (!activeProfile) return;
    if (activeProfile.kind === 'file-transfer') { setFileDialogProfile(activeProfile); setShowFileDialog(true); }
    else openProfileDialog(activeProfile.kind, activeProfile);
  }

  function addFilesProfile() { setShowNewConnection(true); setWizardTarget(null); }

  function openProfile(id: string) {
    setOpenProfileIds((ids) => ids.includes(id) ? ids : [...ids, id]);
    setActiveProfileId(id);
  }

  function closeTab(id: string) {
    setOpenProfileIds((ids) => ids.filter((item) => item !== id));
    if (activeProfileId === id) {
      const remaining = openProfileIds.filter((item) => item !== id);
      setActiveProfileId(remaining.at(-1) ?? null);
    }
  }

  async function saveProfile(input: ProfileSaveInput): Promise<boolean> {
    const result = await window.productivityApi.profiles.save(input);
    if (!result.ok) {
      setError(result.error.message);
      return false;
    }
    await rememberProfileFields(input.profile);
    await Promise.all([refreshProfiles(), refreshCatalog()]);
    setProfileVersions((versions) => ({ ...versions, [input.profile.id]: (versions[input.profile.id] ?? 0) + 1 }));
    openProfile(input.profile.id);
    setError(null);
    return true;
  }

  async function rememberProfileFields(profile: ConnectionProfile) {
    const target = profile.kind === 'database' ? `database:${profile.engine}` : profile.kind === 'ssh' ? 'ssh' : `file-transfer:${profile.protocol}`;
    const candidates: Record<string, unknown> = profile.kind === 'database'
      ? { host: profile.options.host, port: profile.options.port, database: profile.options.database, path: profile.options.path, username: profile.options.username, tls: profile.options.tls }
      : profile.kind === 'ssh'
        ? { host: profile.host, port: profile.port, username: profile.username }
        : profile.protocol === 's3'
          ? { bucket: profile.bucket, region: profile.region }
          : { host: profile.host, port: profile.port, username: profile.username };
    const values = Object.entries(candidates).filter(([, value]) => value !== undefined && value !== '').map(([field, value]) => ({ target, field, value: value as string | number | boolean }));
    if (values.length) await window.productivityApi.connectionCatalog.change({ type: 'remember-fields', values });
  }

  async function removeProfile(profile: ConnectionProfile) {
    if (!window.confirm(`Remove the saved profile “${profile.name}”?`)) return;
    const result = await window.productivityApi.profiles.remove(profile.id);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setOpenProfileIds((ids) => ids.filter((id) => id !== profile.id));
    if (activeProfileId === profile.id) setActiveProfileId(null);
    await refreshProfiles();
  }

  async function checkForUpdates() {
    const result = await window.productivityApi.app.checkForUpdates();
    if (result.ok) setUpdateStatus(result.value);
    else setUpdateStatus({ state: 'error', message: result.error.message });
  }

  async function installUpdate() {
    const result = await window.productivityApi.app.installUpdate();
    if (!result.ok) setUpdateStatus({ state: 'error', message: result.error.message });
  }

  return (
    <div className="app-window">
      <div className="window-topline">
        <div className="window-brand">
          <img className="brand-mark" src={aetherexaIcon} alt="" />
          <span>Aetherexa</span>
          <span className="brand-divider" />
          <span className="brand-section">Workspaces</span>
        </div>
        <div className="window-actions"><span>Local workspace</span><i /></div>
      </div>

      <div className="app-layout">
        <nav className="nav-rail" aria-label="Main navigation">
          <button className="nav-rail-item is-active" aria-label="Workspaces" title="Workspaces"><span>◫</span></button>
          <button className="nav-rail-item" aria-label="Data" title="Data" onClick={() => openProfileDialog('database')}><span>▤</span></button>
          <button className="nav-rail-item" aria-label="SSH hosts" title="SSH hosts" onClick={() => openProfileDialog('ssh')}><span>⌘</span></button>
          <button className="nav-rail-item" aria-label="Data connections" title="Data connections" onClick={addFilesProfile}><span>⇄</span></button>
          <div className="nav-rail-spacer" />
          <button className="nav-rail-item" aria-label="Settings" title="Settings" onClick={() => setShowSettingsDialog(true)}><span>⚙</span></button>
          <div className="account-chip" aria-label="Aetherexa local account">AE</div>
        </nav>

        <ConnectionSidebar
          profiles={profiles}
          groups={catalog.groups}
          activeProfileId={activeProfileId}
          query={search}
          onOpen={openProfile}
          onAddDatabase={() => openProfileDialog('database')}
          onAddSsh={() => openProfileDialog('ssh')}
          onManageGroups={() => setShowGroups(true)}
          onRemove={(profile) => void removeProfile(profile)}
        />

        <main className="workspace-main">
          <div className="main-toolbar">
            <CommandSearch value={search} onChange={setSearch} />
            {activeProfile && <button className="toolbar-shortcut" onClick={editActiveProfile}>Edit profile</button>}
            <button className="toolbar-shortcut" onClick={() => openProfileDialog('database')}><span aria-hidden="true">＋</span> New connection</button>
            <div className="toolbar-divider" />
            <span className="toolbar-avatar">C</span>
          </div>

          <WorkspaceTabs
            tabs={tabs}
            activeId={activeProfileId}
            onSelect={setActiveProfileId}
            onClose={closeTab}
          />

          {error && <div className="app-alert" role="alert"><span>{error}</span><button onClick={() => setError(null)} aria-label="Dismiss">×</button></div>}

          {loading ? (
            <section className="loading-state"><span className="loading-orbit" /> Loading local profiles…</section>
          ) : openProfileIds.length > 0 ? (
            <div className="workspace-keepalive">{openProfileIds.map((id) => { const profile = profiles.find((item) => item.id === id); return profile ? <div className="workspace-keepalive-item" hidden={id !== activeProfileId} key={id}><WorkspaceRouter key={`${id}:${profileVersions[id] ?? 0}`} profile={profile} /></div> : null; })}</div>
          ) : (
            <WelcomeWorkspace
              hasProfiles={profiles.length > 0}
              onAddDatabase={() => openProfileDialog('database')}
              onAddSsh={() => openProfileDialog('ssh')}
            />
          )}

          <footer className="workspace-footer">
            <span><span className="status-dot" /> Offline ready</span>
            <span>Protected local storage</span>
            <span className="app-version">v{version || '0.1.0'}</span>
          </footer>
        </main>
      </div>

      {dialogKind && (
        <ProfileDialog
          key={`${dialogKind}:${editingProfile?.id ?? 'new'}`}
          kind={dialogKind}
          profile={editingProfile}
          onClose={() => { setDialogKind(null); setEditingProfile(undefined); }}
          onSave={saveProfile}
          groups={catalog.groups}
          onCreateGroup={(name) => changeCatalog({ type: 'create-group', name })}
        />
      )}
      {showFileDialog && <FileTransferProfileDialog key={fileDialogProfile?.id ?? 'new-file'} profile={fileDialogProfile} groups={catalog.groups} onCreateGroup={(name) => changeCatalog({ type: 'create-group', name })} onClose={() => { setShowFileDialog(false); setFileDialogProfile(undefined); }} onSave={saveProfile} />}
      {showNewConnection && <>
        {!wizardTarget && <ConnectionWizard onClose={() => setShowNewConnection(false)} onChoose={(target) => { setWizardTarget(target); setChoosingFileProtocol(target === 'files'); }} />}
        {wizardTarget === 'files' && choosingFileProtocol && <FileTypeWizard onClose={() => setShowNewConnection(false)} onBack={() => { setWizardTarget(null); setChoosingFileProtocol(false); }} onChoose={(protocol) => { setWizardFileProtocol(protocol); setChoosingFileProtocol(false); }} />}
        <div style={{ display: wizardTarget === 'database' ? 'contents' : 'none' }}>
          <ProfileDialog kind="database" visible={wizardTarget === 'database'} groups={catalog.groups} profiles={profiles} templates={catalog.templates} reusableValues={catalog.reusableValues} onBack={() => setWizardTarget(null)} onClose={() => setShowNewConnection(false)} onSave={saveProfile} onSaveTemplate={(template) => changeCatalog({ type: 'put-template', template })} onCreateGroup={(name) => changeCatalog({ type: 'create-group', name })} />
        </div>
        <div style={{ display: wizardTarget === 'ssh' ? 'contents' : 'none' }}>
          <ProfileDialog kind="ssh" visible={wizardTarget === 'ssh'} groups={catalog.groups} profiles={profiles} templates={catalog.templates} reusableValues={catalog.reusableValues} onBack={() => setWizardTarget(null)} onClose={() => setShowNewConnection(false)} onSave={saveProfile} onSaveTemplate={(template) => changeCatalog({ type: 'put-template', template })} onCreateGroup={(name) => changeCatalog({ type: 'create-group', name })} />
        </div>
        <div style={{ display: wizardTarget === 'files' && !choosingFileProtocol && wizardFileProtocol ? 'contents' : 'none' }}>
          {(['sftp', 'ftp', 'ftps-explicit', 'ftps-implicit', 's3'] as const).map((protocol) => <div key={protocol} style={{ display: !choosingFileProtocol && wizardFileProtocol === protocol ? 'contents' : 'none' }}>
            <FileTransferProfileDialog initialProtocol={protocol} stepLabel="Step 3 of 3" visible={!choosingFileProtocol && wizardFileProtocol === protocol} groups={catalog.groups} profiles={profiles} templates={catalog.templates} reusableValues={catalog.reusableValues} onBack={() => setChoosingFileProtocol(true)} onClose={() => setShowNewConnection(false)} onSave={saveProfile} onSaveTemplate={(template) => changeCatalog({ type: 'put-template', template })} onCreateGroup={(name) => changeCatalog({ type: 'create-group', name })} />
          </div>)}
        </div>
      </>}
      {showGroups && <GroupManagerDialog groups={catalog.groups} onClose={() => setShowGroups(false)} onChange={changeCatalog} />}
      {showUpdateDialog && <UpdateDialog currentVersion={version} status={updateStatus} onCheck={() => void checkForUpdates()} onInstall={() => void installUpdate()} onClose={() => setShowUpdateDialog(false)} />}
      {showSettingsDialog && <SettingsDialog onClose={() => setShowSettingsDialog(false)} onDirectoryChanged={() => void Promise.all([refreshProfiles(), refreshCatalog()])} onOpenUpdates={() => { setShowSettingsDialog(false); setShowUpdateDialog(true); }} />}
    </div>
  );

  async function changeCatalog(input: import('@shared/profiles').CatalogChange): Promise<boolean> {
    const result = await window.productivityApi.connectionCatalog.change(input);
    if (!result.ok) { setError(result.error.message); return false; }
    setCatalog(result.value);
    if (input.type === 'rename-group' || input.type === 'remove-group') await refreshProfiles();
    setError(null);
    return true;
  }
}

function WelcomeWorkspace({
  hasProfiles,
  onAddDatabase,
  onAddSsh,
}: {
  hasProfiles: boolean;
  onAddDatabase(): void;
  onAddSsh(): void;
}) {
  return (
    <section className="welcome-workspace">
      <div className="welcome-content">
        <div className="welcome-symbol" aria-hidden="true"><span /><span /><span /></div>
        <p className="eyebrow">One workspace for your infrastructure</p>
        <h1>{hasProfiles ? 'Open a connection to get started' : 'Bring your connections together'}</h1>
        <p className="welcome-copy">Manage databases, remote shells, and file transfers from one calm, focused desktop.</p>
        <div className="welcome-actions">
          <button className="button button-primary" onClick={onAddDatabase}><span aria-hidden="true">＋</span> Add data connection</button>
          <button className="button button-secondary" onClick={onAddSsh}><span aria-hidden="true">⌘</span> Add SSH host</button>
        </div>
        <div className="capability-row">
          <div><span className="capability-icon icon-database">DB</span><span><strong>Databases</strong><small>8 engine families</small></span></div>
          <div><span className="capability-icon icon-terminal">&gt;_</span><span><strong>Remote shell</strong><small>SSH terminal tabs</small></span></div>
          <div><span className="capability-icon icon-transfer">⇄</span><span><strong>File transfer</strong><small>Secure SFTP</small></span></div>
        </div>
      </div>
    </section>
  );
}

function ProfileOverview({ profile, onEdit }: { profile: ConnectionProfile; onEdit(): void }) {
  const isDatabase = profile.kind === 'database';
  const subtitle = isDatabase
    ? profile.engine === 'sqlite'
      ? String(profile.options.path ?? 'Local file')
      : `${String(profile.options.host ?? 'Host not set')}${profile.options.port ? `:${profile.options.port}` : ''}`
    : profile.kind === 'ssh'
      ? `${profile.username}@${profile.host}:${profile.port}`
      : profile.protocol === 's3'
        ? `${profile.bucket} · ${profile.region}`
        : `${profile.username}@${profile.host}:${profile.port}`;
  const typeLabel = profile.kind === 'database' ? 'Database profile' : profile.kind === 'ssh' ? 'SSH host profile' : `${profile.protocol.toUpperCase()} file profile`;

  return (
    <section className="profile-overview">
      <div className="overview-breadcrumb"><span>Connections</span><b>/</b><strong>{profile.name}</strong></div>
      <div className="overview-heading">
        <div className={`overview-icon ${isDatabase ? 'icon-database' : 'icon-terminal'}`} aria-hidden="true">{isDatabase ? 'DB' : '&gt;_'}</div>
        <div><p className="eyebrow">{typeLabel}</p><h1>{profile.name}</h1><p className="overview-subtitle">{subtitle}</p></div>
        <button className="button button-secondary overview-edit" onClick={onEdit}>Edit profile</button>
      </div>
      <div className="profile-status-card">
        <div className="profile-status-icon"><span className="status-dot muted" /></div>
        <div><strong>Profile saved</strong><p>Connection workspaces are being added in the next build phase. Your profile is stored locally and ready for its connector.</p></div>
      </div>
      <div className="overview-grid">
        <div className="overview-info-card"><span className="eyebrow">Profile type</span><strong>{isDatabase ? 'Database' : 'SSH host'}</strong></div>
        <div className="overview-info-card"><span className="eyebrow">Group</span><strong>{profile.groupId || 'Ungrouped'}</strong></div>
        <div className="overview-info-card"><span className="eyebrow">Credential storage</span><strong><span className="status-dot" /> Protected on this PC</strong></div>
      </div>
    </section>
  );
}




