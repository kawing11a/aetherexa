import type { ConnectionProfile } from '@shared/profiles';

type ConnectionSidebarProps = {
  profiles: ConnectionProfile[];
  activeProfileId: string | null;
  query: string;
  onOpen(id: string): void;
  onAddDatabase(): void;
  onAddSsh(): void;
  onRemove(profile: ConnectionProfile): void;
};

export function ConnectionSidebar({
  profiles,
  activeProfileId,
  query,
  onOpen,
  onAddDatabase,
  onAddSsh,
  onRemove,
}: ConnectionSidebarProps) {
  const search = query.trim().toLocaleLowerCase();
  const filtered = profiles.filter((profile) =>
    `${profile.name} ${profile.groupId ?? ''} ${profile.kind === 'database' ? engineLabel(profile.engine) : profile.host}`
      .toLocaleLowerCase()
      .includes(search),
  );
  const groups = new Map<string, ConnectionProfile[]>();

  for (const profile of filtered) {
    const groupName = profile.groupId || 'Ungrouped';
    groups.set(groupName, [...(groups.get(groupName) ?? []), profile]);
  }

  return (
    <aside className="connection-sidebar" aria-label="Connections">
      <div className="sidebar-heading">
        <div>
          <p className="eyebrow">Workspace</p>
          <h2>Connections</h2>
        </div>
        <span className="profile-count">{profiles.length}</span>
      </div>

      <div className="sidebar-actions">
        <button className="button button-primary button-small" onClick={onAddDatabase}>
          <span aria-hidden="true">＋</span> Database
        </button>
        <button className="button button-subtle button-small" onClick={onAddSsh}>
          <span aria-hidden="true">＋</span> SSH host
        </button>
      </div>

      <nav className="profile-list" aria-label="Saved connection profiles">
        {groups.size === 0 ? (
          <div className="sidebar-empty">
            {profiles.length === 0 ? 'Your saved profiles will appear here.' : 'No matching profiles.'}
          </div>
        ) : (
          [...groups.entries()].map(([groupName, items]) => (
            <section className="profile-group" key={groupName}>
              <div className="profile-group-title">
                <span className="group-caret" aria-hidden="true">⌄</span>
                <span>{groupName}</span>
                <span className="group-count">{items.length}</span>
              </div>
              {items.map((profile) => (
                <div className={`profile-row${profile.id === activeProfileId ? ' is-active' : ''}`} key={profile.id}>
                  <button className="profile-open" onClick={() => onOpen(profile.id)}>
                    <span className={`profile-kind-mark mark-${profile.kind}`} aria-hidden="true">
                      {profile.kind === 'database' ? 'DB' : 'SH'}
                    </span>
                    <span className="profile-copy">
                      <span className="profile-name">{profile.name}</span>
                      <span className="profile-detail">
                        {profile.kind === 'database' ? engineLabel(profile.engine) : `${profile.username}@${profile.host}`}
                      </span>
                    </span>
                  </button>
                  <button
                    className="profile-remove"
                    aria-label={`Remove ${profile.name}`}
                    title={`Remove ${profile.name}`}
                    onClick={() => onRemove(profile)}
                  >
                    ⋯
                  </button>
                </div>
              ))}
            </section>
          ))
        )}
      </nav>

      <div className="sidebar-footer">
        <span className="status-dot" /> Local profiles
        <span className="footer-lock" aria-hidden="true">▣</span>
      </div>
    </aside>
  );
}

export function engineLabel(engine: string): string {
  const labels: Record<string, string> = {
    mysql: 'MySQL / MariaDB',
    postgres: 'PostgreSQL',
    sqlserver: 'SQL Server',
    oracle: 'Oracle',
    sqlite: 'SQLite',
    mongodb: 'MongoDB',
    redis: 'Redis',
    memcached: 'Memcached',
  };
  return labels[engine] ?? engine;
}
