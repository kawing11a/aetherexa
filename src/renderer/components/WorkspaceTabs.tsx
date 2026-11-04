export type WorkspaceTab = {
  id: string;
  title: string;
  kind: 'database' | 'ssh' | 'file-transfer';
};

type WorkspaceTabsProps = {
  tabs: WorkspaceTab[];
  activeId: string | null;
  onSelect(id: string): void;
  onClose(id: string): void;
};

export function WorkspaceTabs({ tabs, activeId, onSelect, onClose }: WorkspaceTabsProps) {
  if (tabs.length === 0) {
    return <div className="workspace-tabs workspace-tabs-empty" aria-label="No open workspaces" />;
  }

  return (
    <div className="workspace-tabs" role="tablist" aria-label="Open workspaces">
      {tabs.map((tab) => (
        <div
          className={`workspace-tab${tab.id === activeId ? ' is-active' : ''}`}
          key={tab.id}
          role="tab"
          aria-selected={tab.id === activeId}
        >
          <button className="workspace-tab-select" onClick={() => onSelect(tab.id)}>
            <span className={`profile-kind-mark mark-${tab.kind}`} aria-hidden="true">
              {tab.kind === 'database' ? 'DB' : tab.kind === 'ssh' ? 'SH' : 'FT'}
            </span>
            <span className="workspace-tab-title">{tab.title}</span>
          </button>
          <button className="workspace-tab-close" onClick={() => onClose(tab.id)} aria-label={`Close ${tab.title}`}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
