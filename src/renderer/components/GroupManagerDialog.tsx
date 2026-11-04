import { useState } from 'react';
import type { CatalogChange } from '@shared/profiles';

export function GroupManagerDialog({ groups, onChange, onClose }: { groups: string[]; onChange(change: CatalogChange): Promise<boolean>; onClose(): void }) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    if (await onChange({ type: 'create-group', name: name.trim() })) setName('');
    setSaving(false);
  }
  async function rename(group: string) {
    const next = window.prompt(`Rename “${group}” to:`, group)?.trim();
    if (next && next !== group) await onChange({ type: 'rename-group', from: group, to: next });
  }
  async function remove(group: string) {
    if (window.confirm(`Remove the “${group}” group? Connections will move to Ungrouped.`)) await onChange({ type: 'remove-group', name: group });
  }
  return <div className="dialog-scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="profile-dialog group-manager" role="dialog" aria-modal="true" aria-labelledby="group-manager-title">
      <div className="dialog-heading"><div><p className="eyebrow">Connection organization</p><h2 id="group-manager-title">Manage groups</h2></div><button className="icon-button" aria-label="Close dialog" onClick={onClose}>×</button></div>
      <form className="group-create-form" onSubmit={(event) => void submit(event)}><label className="field"><span>New group</span><input maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Production" /></label><button className="button button-primary" disabled={!name.trim() || saving}>{saving ? 'Adding…' : 'Add group'}</button></form>
      <div className="group-manager-list">{groups.length === 0 ? <p className="field-hint">Create a group to organize related database, SSH, and file connections.</p> : groups.map((group) => <div className="group-manager-row" key={group}><strong>{group}</strong><div><button className="button button-subtle button-small" onClick={() => void rename(group)}>Rename</button><button className="button button-subtle button-small" onClick={() => void remove(group)}>Remove</button></div></div>)}</div>
      <div className="dialog-footer"><span className="field-hint">Removing a group keeps its connections and moves them to Ungrouped.</span><button className="button button-secondary" onClick={onClose}>Done</button></div>
    </section>
  </div>;
}
