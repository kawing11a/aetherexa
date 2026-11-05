import { useEffect, useRef, useState } from 'react';
import type { TableColumn, TablePage, WireValue } from '@shared/database';

type ValueKind = 'text' | 'number' | 'boolean' | 'null';
type Draft = { enabled: boolean; kind: ValueKind; value: string };
type Editor = { row: WireValue[] | null; drafts: Draft[] };

type Props = {
  sessionId: string;
  page: TablePage;
  disabled: boolean;
  onBusyChange(busy: boolean): void;
  onChanged(): void;
  onReloadRequired(message: string): void;
};

function display(value: WireValue): string {
  if (value === null) return 'NULL';
  if (value instanceof Uint8Array) return `[binary ${value.byteLength} bytes]`;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
function scalar(value: WireValue): boolean { return value === null || ['string', 'number', 'boolean'].includes(typeof value); }
function makeDraft(value: WireValue, enabled: boolean): Draft {
  const kind: ValueKind = value === null ? 'null' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'text';
  return { enabled, kind, value: value === null || !scalar(value) ? '' : String(value) };
}
function parseDraft(draft: Draft): WireValue {
  if (draft.kind === 'null') return null;
  if (draft.kind === 'text') return draft.value;
  if (draft.kind === 'boolean') return draft.value === 'true';
  if (!draft.value.trim()) throw new Error('Enter a numeric value.');
  const significant = draft.value.replace(/^[+-]/, '').split(/[eE]/)[0].replace('.', '').replace(/^0+|0+$/g, '');
  if (significant.length > 15 && /[.eE]/.test(draft.value)) throw new Error('Use text to preserve this exact decimal.');
  const number = Number(draft.value);
  if (!Number.isFinite(number) || Number.isInteger(number) && !Number.isSafeInteger(number)) throw new Error('Enter a finite number within the safe integer range, or use text for an exact decimal.');
  return number;
}
function keyFor(columns: TableColumn[], row: WireValue[]): Record<string, WireValue> | null {
  const keys = columns.map((column, index) => ({ column, index })).filter(({ column }) => column.primaryKeyOrder !== null);
  if (!keys.length || keys.some(({ index }) => row[index] === null || !scalar(row[index]) && !(row[index] instanceof Uint8Array))) return null;
  return Object.fromEntries(keys.map(({ column, index }) => [column.name, row[index]]));
}

export function EditableTableGrid({ sessionId, page, disabled, onBusyChange, onChanged, onReloadRequired }: Props) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => { if (editor) dialog.current?.focus(); }, [editor?.row]);
  const columns = page.definition.columns;
  const hasKey = columns.some((column) => column.primaryKeyOrder !== null);
  const setPending = (next: boolean) => { setBusy(next); onBusyChange(next); };
  function start(row: WireValue[] | null) {
    setError('');
    setEditor({ row, drafts: columns.map((_, index) => makeDraft(row?.[index] ?? null, false)) });
  }
  function changeDraft(index: number, patch: Partial<Draft>) {
    setEditor((current) => current && ({ ...current, drafts: current.drafts.map((item, i) => i === index ? { ...item, ...patch } : item) }));
  }
  async function save() {
    if (!editor || busy || disabled) return;
    let dispatched = false;
    try {
      const pairs = editor.drafts.flatMap((draft, index) => {
        if (!draft.enabled) return [];
        const value = parseDraft(draft);
        if (editor.row && Object.is(value, editor.row[index])) return [];
        return [[columns[index].name, value] as const];
      });
      if (editor.row && !pairs.length) { setError('Select at least one changed value.'); return; }
      const values = Object.fromEntries(pairs);
      const key = editor.row ? keyFor(columns, editor.row) : null;
      if (editor.row && !key) { setError('This row has a primary-key value that cannot be edited safely.'); return; }
      const expectedValues = editor.row ? Object.fromEntries(pairs.map(([name]) => [name, editor.row![columns.findIndex((column) => column.name === name)]])) : {};
      setPending(true); setError(''); dispatched = true;
      const api = window.productivityApi.database;
      const result = editor.row
        ? await api.updateRow({ sessionId, input: { table: page.definition.table, key: key!, expectedValues, values } })
        : await api.insertRow({ sessionId, input: { table: page.definition.table, values } });
      if (!result.ok) {
        if (result.error.code === 'stale-row' || result.error.code === 'completion-unknown') { setEditor(null); onReloadRequired(result.error.message); }
        else setError(result.error.message);
      } else if (result.value.affectedRows !== 1) { setEditor(null); onReloadRequired('The write result is uncertain. Reload before editing again.'); }
      else { setEditor(null); onChanged(); }
    } catch (problem) {
      if (dispatched) { setEditor(null); onReloadRequired('The write result is uncertain. Reload before editing again.'); }
      else setError(problem instanceof Error ? problem.message : 'The row could not be saved.');
    } finally { setPending(false); }
  }
  async function remove(row: WireValue[]) {
    const key = keyFor(columns, row);
    if (!key || busy || disabled || !window.confirm('Delete this row?')) return;
    setPending(true); setError('');
    try {
      const result = await window.productivityApi.database.deleteRow({ sessionId, input: { table: page.definition.table, key } });
      if (!result.ok) {
        if (result.error.code === 'stale-row' || result.error.code === 'completion-unknown') onReloadRequired(result.error.message);
        else setError(result.error.message);
      } else if (result.value.affectedRows !== 1) onReloadRequired('The write result is uncertain. Reload before editing again.');
      else onChanged();
    } catch { onReloadRequired('The write result is uncertain. Reload before editing again.'); }
    finally { setPending(false); }
  }
  return <>
    <div className="data-toolbar"><span>{hasKey ? 'Rows' : 'Read-only: this table has no primary key.'}</span><button className="button button-secondary button-small" disabled={!hasKey || disabled || busy} onClick={() => start(null)}>Insert row</button></div>
    {error && <div className="workspace-error" role="alert">{error}</div>}
    <div className="results-grid-wrap"><table className="results-grid table-browser-grid"><thead><tr><th>Row</th>{columns.map((item) => <th key={item.name}><span>{item.name}{item.primaryKeyOrder !== null ? ' · PK ' + item.primaryKeyOrder : ''}</span><small>{item.typeName}{item.nullable ? ' · nullable' : ' · not null'}{item.defaultExpression !== null ? ' · default ' + item.defaultExpression : ''}</small></th>)}<th>Actions</th></tr></thead>
      <tbody>{page.rows.map((row, index) => <tr key={index}><td>{page.offset + index + 1}</td>{columns.map((item, i) => <td key={item.name} title={display(row[i])}>{display(row[i])}</td>)}<td><button className="button button-subtle button-small" disabled={!hasKey || !keyFor(columns, row) || disabled || busy} onClick={() => start(row)}>Edit</button><button className="button button-subtle button-small" disabled={!hasKey || !keyFor(columns, row) || disabled || busy} onClick={() => void remove(row)}>Delete</button></td></tr>)}</tbody></table>{page.rows.length === 0 && <div className="results-note">No rows on this page. Adjust filters or insert a row.</div>}</div>
    {editor && <div className="table-dialog-backdrop"><section ref={dialog} tabIndex={-1} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) setEditor(null); }} className="table-dialog" role="dialog" aria-modal="true" aria-labelledby="row-editor-title"><h2 id="row-editor-title">{editor.row ? 'Edit row' : 'Insert row'}</h2><p>Select the columns to {editor.row ? 'change' : 'provide'}. Other columns {editor.row ? 'remain unchanged' : 'use database defaults'}.</p>
      <div className="table-fields">{columns.map((item, index) => {
        const draft = editor.drafts[index]; const supported = !editor.row || scalar(editor.row[index]);
        return <div className="table-field" key={item.name}><label><input type="checkbox" checked={draft.enabled} disabled={!supported || busy} onChange={(event) => changeDraft(index, { enabled: event.target.checked })} /> {item.name} <small>{item.typeName}</small></label>
          <select aria-label={`${item.name} value type`} value={draft.kind} disabled={!draft.enabled || busy} onChange={(event) => changeDraft(index, { kind: event.target.value as ValueKind, value: event.target.value === 'boolean' ? 'true' : '' })}><option value="text">Text</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="null">NULL</option></select>
          {draft.kind === 'boolean' ? <select aria-label={`${item.name} value`} value={draft.value} disabled={!draft.enabled || busy} onChange={(event) => changeDraft(index, { value: event.target.value })}><option value="true">true</option><option value="false">false</option></select> : draft.kind !== 'null' ? <input aria-label={`${item.name} value`} value={draft.value} disabled={!draft.enabled || busy} onChange={(event) => changeDraft(index, { value: event.target.value })} /> : <span>NULL</span>}
          {!supported && <small>Binary or structured values are read-only.</small>}</div>;
      })}</div>{error && <div className="workspace-error" role="alert">{error}</div>}<div className="table-dialog-actions"><button className="button button-subtle" disabled={busy} onClick={() => setEditor(null)}>Cancel</button><button className="button button-primary" disabled={busy || disabled} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button></div></section></div>}
  </>;
}
