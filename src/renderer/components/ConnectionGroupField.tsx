export function ConnectionGroupField({ value, groups, onChange, onCreate }: { value: string; groups: string[]; onChange(value: string): void; onCreate(name: string): Promise<boolean> }) {
  async function select(next: string) {
    if (next !== '__create__') { onChange(next); return; }
    const name = window.prompt('Create a connection group:')?.trim();
    if (name && await onCreate(name)) onChange(name);
  }
  return <label className="field field-wide"><span>Group <em>Optional</em></span><div className="field-inline-select"><select value={value} onChange={(event) => void select(event.target.value)}><option value="">Ungrouped</option>{groups.map((group) => <option key={group} value={group}>{group}</option>)}<option value="__create__">＋ Create a new group…</option></select></div></label>;
}
