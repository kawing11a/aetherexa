import { useEffect, useRef, useState } from 'react';
import type { ColumnTypeOption, NewTableColumn, TableChange, TableChangePreview, TableDefinition, TableIdentifier, WireValue } from '@shared/database';

type DraftColumn = { name: string; typeName: string; args: string[]; nullable: boolean; defaultKind: 'none' | 'literal' | 'current-timestamp'; valueKind: 'text' | 'number' | 'boolean' | 'null'; value: string; primary: boolean };
type Props = { sessionId: string; namespace: string; definition?: TableDefinition; onClose(): void; onApplied(table: TableIdentifier): void };
function newColumn(option?: ColumnTypeOption): DraftColumn {
  return { name: '', typeName: option?.name ?? '', args: Array.from({ length: option?.argumentCount ?? 0 }, () => String(option?.minArgument ?? 0)), nullable: true, defaultKind: 'none', valueKind: 'text', value: '', primary: false };
}
function literalValue(item: DraftColumn): WireValue {
  if (item.valueKind === 'null') return null;
  if (item.valueKind === 'text') return item.value;
  if (item.valueKind === 'boolean') return item.value === 'true';
  if (!item.value.trim()) throw new Error('Enter a numeric default.');
  const significant = item.value.replace(/^[+-]/, '').split(/[eE]/)[0].replace('.', '').replace(/^0+|0+$/g, '');
  if (significant.length > 15 && /[.eE]/.test(item.value)) throw new Error('Use text to preserve this exact decimal.');
  const value = Number(item.value);
  if (value === 0 && significant.length > 0) throw new Error('This number is too small to represent. Use text to preserve it.');
  if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error('Use a finite number within the safe integer range, or select text for an exact decimal.');
  return value;
}
function toColumn(item: DraftColumn, options: ColumnTypeOption[]): NewTableColumn {
  const option = options.find((candidate) => candidate.name === item.typeName);
  if (!item.name.trim() || !option || item.args.length !== option.argumentCount) throw new Error('Enter a column name and select a type.');
  const args = item.args.map((value) => {
    if (!/^\d+$/.test(value)) throw new Error('Type arguments must be whole numbers.');
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < option.minArgument || number > option.maxArgument) throw new Error('A type argument is outside its allowed range.');
    return number;
  });
  if (item.primary && item.nullable) throw new Error('Primary-key columns must be non-nullable.');
  const defaultValue: NewTableColumn['default'] = item.defaultKind === 'literal' ? { kind: 'literal', value: literalValue(item) } : { kind: item.defaultKind };
  return { name: item.name, type: { name: option.name, arguments: args }, nullable: item.nullable, default: defaultValue };
}

export function TableDesignerDialog({ sessionId, namespace, definition, onClose, onApplied }: Props) {
  const [options, setOptions] = useState<ColumnTypeOption[]>([]);
  const [mode, setMode] = useState<'create' | 'add-column' | 'rename-column' | 'drop-column'>(definition ? 'add-column' : 'create');
  const [tableName, setTableName] = useState(definition?.table.name ?? '');
  const [columns, setColumns] = useState<DraftColumn[]>([newColumn()]);
  const [selected, setSelected] = useState(definition?.columns[0]?.name ?? '');
  const [renameTo, setRenameTo] = useState('');
  const [preview, setPreview] = useState<TableChangePreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => { dialog.current?.focus(); }, []);
  useEffect(() => {
    let active = true;
    void window.productivityApi.database.listColumnTypes({ sessionId }).then((result) => {
      if (!active) return;
      if (!result.ok) { setError(result.error.message); return; }
      setOptions(result.value);
      setColumns((items) => items.map((item) => item.typeName ? item : { ...item, typeName: result.value[0]?.name ?? '', args: Array.from({ length: result.value[0]?.argumentCount ?? 0 }, () => String(result.value[0]?.minArgument ?? 0)) }));
    }).catch(() => { if (active) setError('Column types could not be loaded.'); });
    return () => { active = false; generation.current++; };
  }, [sessionId]);
  function invalidate() { generation.current++; setPreview(null); setConfirmed(false); setError(''); }
  function updateColumn(index: number, patch: Partial<DraftColumn>) { invalidate(); setColumns((items) => items.map((item, i) => i === index ? { ...item, ...patch } : item)); }
  function buildChange(): TableChange {
    const table = { namespace, name: tableName };
    if (!table.name.trim()) throw new Error('Enter a table name.');
    if (mode === 'create') return { kind: 'create', table, columns: columns.map((item) => toColumn(item, options)), primaryKey: columns.filter((item) => item.primary).map((item) => item.name) };
    if (!definition) throw new Error('Open a table first.');
    if (mode === 'add-column') return { kind: 'add-column', table: definition.table, column: toColumn(columns[0], options) };
    if (!selected) throw new Error('Choose a column.');
    if (mode === 'rename-column') { if (!renameTo.trim()) throw new Error('Enter the new column name.'); return { kind: 'rename-column', table: definition.table, from: selected, to: renameTo }; }
    return { kind: 'drop-column', table: definition.table, column: selected };
  }
  async function makePreview() {
    try {
      const change = buildChange(); const id = ++generation.current;
      setBusy(true); setError(''); setPreview(null); setConfirmed(false);
      const result = await window.productivityApi.database.previewTableChange({ sessionId, change });
      if (generation.current !== id) return;
      if (result.ok) setPreview(result.value); else setError(result.error.message);
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'The change could not be previewed.'); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!preview || busy || preview.destructive && !confirmed) return;
    setBusy(true); setError('');
    try {
      const result = await window.productivityApi.database.applyTableChange({ sessionId, planId: preview.planId, confirmDestructive: confirmed });
      if (!result.ok) { setPreview(null); setConfirmed(false); setError(result.error.message); }
      else onApplied({ namespace, name: tableName });
    } catch { setPreview(null); setConfirmed(false); setError('The change result is uncertain. Reload the table before trying again.'); }
    finally { setBusy(false); }
  }
  return <div className="table-dialog-backdrop"><section ref={dialog} tabIndex={-1} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) onClose(); }} className="table-dialog table-designer" role="dialog" aria-modal="true" aria-labelledby="table-designer-title"><h2 id="table-designer-title">{definition ? 'Design table' : 'Create table'}</h2><p>{namespace}{definition ? ' / ' + definition.table.name : ''}</p>
    <fieldset disabled={busy}>
      {definition ? <label className="table-label">Change <select value={mode} onChange={(event) => { invalidate(); setMode(event.target.value as typeof mode); }}><option value="add-column">Add column</option><option value="rename-column">Rename column</option><option value="drop-column">Drop column</option></select></label> : <label className="table-label">Table name <input value={tableName} onChange={(event) => { invalidate(); setTableName(event.target.value); }} /></label>}
      {(mode === 'create' || mode === 'add-column') && <><div className="table-fields">{(mode === 'create' ? columns : columns.slice(0, 1)).map((item, index) => {
        const option = options.find((value) => value.name === item.typeName);
        return <div className="table-column-draft" key={index}><div className="data-toolbar"><label>Column <input aria-label={`Column ${index + 1} name`} value={item.name} onChange={(event) => updateColumn(index, { name: event.target.value })} /></label><label>Type <select aria-label={`Column ${index + 1} type`} value={item.typeName} onChange={(event) => { const next = options.find((value) => value.name === event.target.value); updateColumn(index, { typeName: event.target.value, args: Array.from({ length: next?.argumentCount ?? 0 }, () => String(next?.minArgument ?? 0)) }); }}><option value="">Select type</option>{options.map((value) => <option key={value.name} value={value.name}>{value.label}</option>)}</select></label>
          {item.args.map((value, arg) => <label key={arg}>Argument {arg + 1} <input type="number" aria-label={`Column ${index + 1} type argument ${arg + 1}`} min={option?.minArgument} max={option?.maxArgument} step={1} value={value} onChange={(event) => updateColumn(index, { args: item.args.map((current, i) => i === arg ? event.target.value : current) })} /></label>)}
          <label><input type="checkbox" checked={item.nullable} onChange={(event) => updateColumn(index, { nullable: event.target.checked })} /> Nullable</label>{mode === 'create' && <label><input type="checkbox" checked={item.primary} onChange={(event) => updateColumn(index, { primary: event.target.checked, ...(event.target.checked ? { nullable: false } : {}) })} /> Primary key</label>}{mode === 'create' && columns.length > 1 && <button className="button button-subtle button-small" onClick={() => { invalidate(); setColumns((items) => items.filter((_, i) => i !== index)); }}>Remove</button>}</div>
          <div className="data-toolbar"><label>Default <select value={item.defaultKind} onChange={(event) => updateColumn(index, { defaultKind: event.target.value as DraftColumn['defaultKind'] })}><option value="none">None</option><option value="literal">Literal value</option><option value="current-timestamp">Current timestamp</option></select></label>{item.defaultKind === 'literal' && <><select aria-label={`Column ${index + 1} default type`} value={item.valueKind} onChange={(event) => updateColumn(index, { valueKind: event.target.value as DraftColumn['valueKind'], value: event.target.value === 'boolean' ? 'true' : '' })}><option value="text">Text</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="null">NULL</option></select>{item.valueKind === 'boolean' ? <select aria-label={`Column ${index + 1} default value`} value={item.value} onChange={(event) => updateColumn(index, { value: event.target.value })}><option value="true">true</option><option value="false">false</option></select> : item.valueKind !== 'null' && <input aria-label={`Column ${index + 1} default value`} value={item.value} onChange={(event) => updateColumn(index, { value: event.target.value })} />}</>}</div></div>;
      })}</div>{mode === 'create' && <button className="button button-subtle button-small" disabled={columns.length >= 256 || !options.length} onClick={() => { invalidate(); setColumns((items) => [...items, newColumn(options[0])]); }}>Add column</button>}</>}
      {(mode === 'rename-column' || mode === 'drop-column') && <div className="data-toolbar"><label>Column <select value={selected} onChange={(event) => { invalidate(); setSelected(event.target.value); }}>{definition?.columns.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>{mode === 'rename-column' && <label>New name <input value={renameTo} onChange={(event) => { invalidate(); setRenameTo(event.target.value); }} /></label>}</div>}
    </fieldset>
    {error && <div className="workspace-error" role="alert">{error}</div>}
    {preview && <div className="table-preview"><strong>SQL preview</strong>{preview.statements.map((statement, index) => <pre key={index}>{statement}</pre>)}{preview.destructive && <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} /> I confirm this destructive change.</label>}</div>}
    <div className="table-dialog-actions"><button className="button button-subtle" disabled={busy} onClick={onClose}>Cancel</button><button className="button button-secondary" disabled={busy || !options.length} onClick={() => void makePreview()}>Preview SQL</button><button className="button button-primary" disabled={busy || !preview || preview.destructive && !confirmed} onClick={() => void apply()}>{busy ? 'Working…' : 'Apply'}</button></div>
  </section></div>;
}
