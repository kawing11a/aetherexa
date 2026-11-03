type CommandSearchProps = {
  value: string;
  onChange(value: string): void;
};

export function CommandSearch({ value, onChange }: CommandSearchProps) {
  return (
    <label className="command-search">
      <span className="search-glyph" aria-hidden="true">⌕</span>
      <span className="sr-only">Filter connections and workspaces</span>
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Find a connection or workspace"
      />
      <kbd>Ctrl K</kbd>
    </label>
  );
}
