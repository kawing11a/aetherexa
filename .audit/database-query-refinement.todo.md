# Database query and table editing refinement

## Design plan

- Subject: a multi-engine database workspace for developers inspecting and changing table data.
- Audience: developers who need to browse objects, open SQL deliberately, and make guarded row edits.
- Palette: preserve Aetherexa's existing ink/navy workspace, muted steel labels, teal focus, and restrained row status colors.
- Type: keep the existing compact UI sans-serif for controls and monospace SQL/data values.
- Layout: profile header, an Objects view by default, a small tab strip, an on-demand SQL query view, and a full-height table grid without an editor above it.
- Signature: inline row editing paints one active row as a draft and places Cancel and Confirm & commit beside it.

## Work

- [x] Ground current editor and row-write flows
- [x] Compare UI state and transaction boundaries
- [x] Hide SQL editor until query view is opened
- [x] Add inline table row edit and cancel/commit controls
- [x] Verify typecheck, build, and diff

## Data shapes

```ts
type WorkspaceView =
  | { kind: 'objects' }
  | { kind: 'query' }
  | { kind: 'table'; table: TableIdentifier };

type RowEditor = {
  rowIndex: number;
  original: WireValue[];
  drafts: Draft[];
};
```

Confirm calls the existing `updateRow` contract. Its connector transaction commits the single-row mutation; Cancel only drops the renderer-owned draft. Multi-row transaction batching is not part of the request.
