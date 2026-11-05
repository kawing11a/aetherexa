import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { CatalogChange, ConnectionProfile } from '@shared/profiles';
import { connectionSections, getSection, groupKeyId, profileDetail, sectionTree } from './connectionSections.js';
import type { ConnectionSection, GroupKey } from './connectionSections.js';

export { engineLabel } from './connectionSections.js';

type Props = {
  profiles: ConnectionProfile[];
  groups: string[];
  activeProfileId: string | null;
  query: string;
  onOpen(id: string): void;
  onAddProfile(section: ConnectionSection, group?: string): void;
  onEdit(profile: ConnectionProfile): void;
  onManageGroups(): void;
  onSettings(): void;
  onRemove(profile: ConnectionProfile): void;
  onChangeGroup(change: CatalogChange): Promise<string | null>;
};

type MenuTarget = { kind: 'panel' | 'add' } | { kind: 'group'; key: GroupKey } | { kind: 'profile'; profile: ConnectionProfile };
type MenuState = { target: MenuTarget; x: number; y: number; invoker: HTMLElement | null };
type GroupDialog = { kind: 'create' } | { kind: 'rename' | 'remove'; name: string };

export function ConnectionSidebar({ profiles, groups, activeProfileId, query, onOpen, onAddProfile, onEdit, onManageGroups, onSettings, onRemove, onChangeGroup }: Props) {
  const [section, setSection] = useState<ConnectionSection>('database');
  const [collapsed, setCollapsed] = useState(false);
  const [closedGroups, setClosedGroups] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<GroupDialog | null>(null);
  const [groupName, setGroupName] = useState('');
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const dialogInvoker = useRef<HTMLElement | null>(null);
  const definition = getSection(section);
  const sectionProfiles = profiles.filter(definition.matches);
  const active = sectionProfiles.find((profile) => profile.id === activeProfileId);
  const tree = sectionTree(section, profiles, groups, query);

  function dismissMenu(restoreFocus = true) {
    if (restoreFocus) menu?.invoker?.focus();
    setMenu(null);
  }

  useEffect(() => {
    if (!menu) return;
    const element = menuRef.current;
    if (element) {
      const rect = element.getBoundingClientRect();
      element.style.left = `${Math.min(menu.x, Math.max(8, window.innerWidth - rect.width - 8))}px`;
      element.style.top = `${Math.min(menu.y, Math.max(8, window.innerHeight - rect.height - 8))}px`;
      element.querySelector<HTMLButtonElement>('button')?.focus();
    }
    const outside = (event: PointerEvent) => { if (!element?.contains(event.target as Node)) setMenu(null); };
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, [menu]);

  useEffect(() => {
    if (!dialog) return;
    (dialogRef.current?.querySelector<HTMLElement>('input') ?? dialogRef.current?.querySelector<HTMLElement>('button'))?.focus();
    return () => dialogInvoker.current?.focus();
  }, [dialog]);

  function showMenu(target: MenuTarget, event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointer = 'clientX' in event && event.type === 'contextmenu';
    const invoker = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>('button') ?? event.currentTarget : event.currentTarget;
    setMenu({ target, x: pointer ? event.clientX : bounds.left, y: pointer ? event.clientY : bounds.bottom + 4, invoker });
  }

  function keyboardMenu(target: MenuTarget, event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) showMenu(target, event);
  }

  function groupDialog(next: GroupDialog) {
    dialogInvoker.current = menu?.invoker ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    dismissMenu(false);
    setGroupName(next.kind === 'rename' ? next.name : '');
    setDialogError(null);
    setDialog(next);
  }

  async function submitGroup() {
    if (!dialog) return;
    setSaving(true);
    const change: CatalogChange = dialog.kind === 'create' ? { type: 'create-group', name: groupName.trim() }
      : dialog.kind === 'rename' ? { type: 'rename-group', from: dialog.name, to: groupName.trim() }
        : { type: 'remove-group', name: dialog.name };
    try {
      const error = await onChangeGroup(change);
      setDialogError(error);
      if (!error) setDialog(null);
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : 'Could not update the group.');
    } finally { setSaving(false); }
  }

  function toggleGroup(key: string) {
    setClosedGroups((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }

  function menuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') { event.preventDefault(); dismissMenu(); }
    if (event.key === 'Tab') dismissMenu(false);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }

  const addProfile = (group?: string) => { dismissMenu(false); onAddProfile(section, group); };
  const menuAction = (label: string, action: () => void, danger = false) => <button type="button" role="menuitem" className={danger ? 'is-danger' : undefined} onClick={action}>{label}</button>;

  return <>
    <nav className={`nav-rail section-rail${collapsed ? ' is-collapsed' : ''}`} aria-label="Connection sections">
      <button className="nav-rail-item rail-toggle" aria-label={collapsed ? 'Expand section navigation' : 'Collapse section navigation'} title={collapsed ? 'Expand navigation' : 'Collapse navigation'} aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}><SectionIcon icon="panel" /><span className="nav-section-label">Connections</span><span className="rail-toggle-arrow" aria-hidden="true">‹</span></button>
      <div className="rail-section-list">{connectionSections.map((item) => <button key={item.id} className={`nav-rail-item${section === item.id ? ' is-active' : ''}`} aria-current={section === item.id ? 'page' : undefined} aria-label={item.label} title={collapsed ? item.label : undefined} onClick={() => { setSection(item.id); dismissMenu(false); }}><SectionIcon icon={item.icon} /><span className="nav-section-label">{item.label}</span></button>)}</div>
      <div className="nav-rail-spacer" />
      <button className="nav-rail-item" aria-label="Settings" title={collapsed ? 'Settings' : undefined} onClick={onSettings}><SectionIcon icon="settings" /><span className="nav-section-label">Settings</span></button>
    </nav>

    <aside className="connection-sidebar" tabIndex={-1} aria-label={`${definition.label} profiles`} onContextMenu={(event) => showMenu({ kind: 'panel' }, event)} onKeyDown={(event) => keyboardMenu({ kind: 'panel' }, event)}>
      <div className="sidebar-heading"><div><p className="eyebrow">Section</p><h2>{definition.label}</h2></div><span className="profile-count">{sectionProfiles.length}</span></div>
      <div className="section-add-row"><button className="button button-primary button-small section-add-button" aria-haspopup="menu" aria-expanded={menu?.target.kind === 'add'} onClick={(event) => menu?.target.kind === 'add' ? dismissMenu() : showMenu({ kind: 'add' }, event)}><span aria-hidden="true">＋</span> Add <span className="add-chevron" aria-hidden="true">⌄</span></button><button className="icon-button section-more" aria-label={`${definition.label} section actions`} aria-haspopup="menu" onClick={(event) => showMenu({ kind: 'panel' }, event)}>⋯</button></div>
      <div className="section-selection"><span className="selection-label">Selected {definition.noun}</span>{active ? <button onClick={() => onOpen(active.id)} title={profileDetail(active)}><span className="selection-dot" /><span>{active.name}</span></button> : <span className="selection-empty">None selected in this section</span>}</div>
      <nav className="profile-list section-profile-list" aria-label={`${definition.label} profile groups`}>
        {query.trim() && tree.length === 0 ? <div className="sidebar-empty">No matching profiles in {definition.label}.</div> : <ul className="connection-tree">{tree.map(({ key, profiles: items }) => {
          const id = groupKeyId(key);
          const open = Boolean(query.trim()) || !closedGroups.has(id);
          const label = key.kind === 'named' ? key.name : 'No group';
          return <li className="profile-group" key={id} onContextMenu={(event) => showMenu({ kind: 'group', key }, event)} onKeyDown={(event) => keyboardMenu({ kind: 'group', key }, event)}>
            <div className="profile-group-header"><button className="profile-group-title" aria-expanded={open} onClick={() => toggleGroup(id)}><span className={`group-caret${open ? ' is-open' : ''}`} aria-hidden="true">›</span><SectionIcon icon="folder" /><span className="group-label">{label}</span><span className="group-count">{items.length}</span></button><button className="profile-menu-button" aria-label={`Actions for ${label}`} aria-haspopup="menu" onClick={(event) => showMenu({ kind: 'group', key }, event)}>⋯</button></div>
            {open && <ul className="group-profiles">{items.map((profile) => <li className={`profile-row${profile.id === activeProfileId ? ' is-active' : ''}`} key={profile.id} onContextMenu={(event) => showMenu({ kind: 'profile', profile }, event)} onKeyDown={(event) => keyboardMenu({ kind: 'profile', profile }, event)}><button className="profile-open" onClick={() => onOpen(profile.id)} aria-current={profile.id === activeProfileId ? 'true' : undefined}><span className={`profile-kind-mark mark-${profile.kind}`} aria-hidden="true"><SectionIcon icon={definition.icon} /></span><span className="profile-copy"><span className="profile-name">{profile.name}</span><span className="profile-detail">{profileDetail(profile)}</span></span></button><button className="profile-menu-button" aria-label={`Actions for ${profile.name}`} aria-haspopup="menu" onClick={(event) => showMenu({ kind: 'profile', profile }, event)}>⋯</button></li>)}{items.length === 0 && <li className="group-empty">No profiles</li>}</ul>}
          </li>;
        })}</ul>}
        {sectionProfiles.length === 0 && !query.trim() && <div className="sidebar-empty">Add a {definition.noun} to start browsing {definition.label}.</div>}
      </nav>
      <div className="sidebar-footer"><span className="status-dot" /> Saved locally<span className="footer-lock" aria-hidden="true">▣</span></div>
    </aside>

    {menu && createPortal(<div ref={menuRef} className="connection-context-menu" role="menu" aria-label={menu.target.kind === 'add' ? 'Add to section' : 'Connection actions'} style={{ left: menu.x, top: menu.y }} onKeyDown={menuKeyDown}>
      {(menu.target.kind === 'panel' || menu.target.kind === 'add') && <>{menuAction('Add profile', () => addProfile())}{menuAction('Add group', () => groupDialog({ kind: 'create' }))}{menu.target.kind === 'panel' && menuAction('Manage groups…', () => { dismissMenu(false); onManageGroups(); })}</>}
      {menu.target.kind === 'group' && <>{menuAction('Add profile', () => addProfile(menu.target.kind === 'group' && menu.target.key.kind === 'named' ? menu.target.key.name : undefined))}{menuAction('Add group', () => groupDialog({ kind: 'create' }))}{menu.target.key.kind === 'named' && <><div className="context-menu-divider" />{menuAction('Rename group…', () => { if (menu.target.kind === 'group' && menu.target.key.kind === 'named') groupDialog({ kind: 'rename', name: menu.target.key.name }); })}{menuAction('Remove group…', () => { if (menu.target.kind === 'group' && menu.target.key.kind === 'named') groupDialog({ kind: 'remove', name: menu.target.key.name }); }, true)}</>}</>}
      {menu.target.kind === 'profile' && <>{menuAction('Open profile', () => { if (menu.target.kind === 'profile') onOpen(menu.target.profile.id); dismissMenu(); })}{menuAction('Edit profile…', () => { if (menu.target.kind === 'profile') onEdit(menu.target.profile); dismissMenu(false); })}<div className="context-menu-divider" />{menuAction('Remove profile…', () => { if (menu.target.kind === 'profile') onRemove(menu.target.profile); dismissMenu(); }, true)}</>}
    </div>, document.body)}

    {dialog && createPortal(<div className="dialog-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setDialog(null); }}><section ref={dialogRef} className="profile-dialog sidebar-group-dialog" role="dialog" aria-modal="true" aria-labelledby="sidebar-group-title" onKeyDown={(event) => {
      if (event.key === 'Escape' && !saving) { event.stopPropagation(); setDialog(null); }
      if (event.key === 'Tab') { const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('input, button:not(:disabled)')]; const first = controls[0]; const last = controls.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
    }}><div className="dialog-heading"><div><p className="eyebrow">Shared profile groups</p><h2 id="sidebar-group-title">{dialog.kind === 'create' ? 'Add group' : dialog.kind === 'rename' ? 'Rename group' : 'Remove group'}</h2></div><button className="icon-button" disabled={saving} aria-label="Close group dialog" onClick={() => setDialog(null)}>×</button></div><form onSubmit={(event) => { event.preventDefault(); void submitGroup(); }}>{dialog.kind === 'remove' ? <p className="dialog-intro">Remove “{dialog.name}” from all sections? Its profiles will move to No group.</p> : <label className="field"><span>Group name</span><input required maxLength={80} value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="e.g. Production" /></label>}<p className="field-hint">Groups are shared across Database, Bucket, SSH, and FTP / SFTP.</p>{dialogError && <p className="group-dialog-error" role="alert">{dialogError}</p>}<div className="dialog-footer"><button className="button button-subtle" type="button" disabled={saving} onClick={() => setDialog(null)}>Cancel</button><button className={`button ${dialog.kind === 'remove' ? 'button-secondary' : 'button-primary'}`} disabled={saving || (dialog.kind !== 'remove' && !groupName.trim())}>{saving ? 'Saving…' : dialog.kind === 'remove' ? 'Remove group' : dialog.kind === 'rename' ? 'Save name' : 'Create group'}</button></div></form></section></div>, document.body)}
  </>;
}

function SectionIcon({ icon }: { icon: string }) {
  const paths: Record<string, ReactNode> = {
    database: <><ellipse cx="12" cy="5" rx="7" ry="3" /><path d="M5 5v14c0 4 14 4 14 0V5M5 12c0 4 14 4 14 0" /></>,
    bucket: <><path d="M4 6h16l-2 14H6L4 6ZM4 6c0-4 16-4 16 0M8 10v3a4 4 0 0 0 8 0v-3" /></>,
    terminal: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3m6 0h4" /></>,
    files: <><path d="M4 5h6l2 3h8v12H4V5Zm3 9h10m-3-3 3 3-3 3" /></>,
    folder: <path d="M3 6h7l2 3h9v11H3V6Z" />,
    panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="m9 3 6 0 1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Z" /></>,
  };
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[icon]}</svg>;
}
