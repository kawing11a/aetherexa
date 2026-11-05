import type { ConnectionProfile, FileTransferProfile } from '@shared/profiles';

export type ConnectionSection = 'database' | 'bucket' | 'ssh' | 'files';
export type GroupKey = { kind: 'named'; name: string } | { kind: 'ungrouped' };
export type SectionGroup = { key: GroupKey; profiles: ConnectionProfile[] };

type SectionDefinition = {
  id: ConnectionSection;
  label: string;
  noun: string;
  icon: 'database' | 'bucket' | 'terminal' | 'files';
  matches(profile: ConnectionProfile): boolean;
  wizard: 'database' | 'ssh' | 's3' | 'file-protocol';
};

export const connectionSections: readonly SectionDefinition[] = [
  { id: 'database', label: 'Database', noun: 'connection', icon: 'database', matches: (profile) => profile.kind === 'database', wizard: 'database' },
  { id: 'bucket', label: 'Bucket', noun: 'bucket', icon: 'bucket', matches: (profile) => profile.kind === 'file-transfer' && profile.protocol === 's3', wizard: 's3' },
  { id: 'ssh', label: 'SSH', noun: 'host', icon: 'terminal', matches: (profile) => profile.kind === 'ssh', wizard: 'ssh' },
  { id: 'files', label: 'FTP / SFTP', noun: 'connection', icon: 'files', matches: (profile) => profile.kind === 'file-transfer' && profile.protocol !== 's3', wizard: 'file-protocol' },
];

export const transferProtocols: Exclude<FileTransferProfile['protocol'], 's3'>[] = ['sftp', 'ftp', 'ftps-explicit', 'ftps-implicit'];

export function getSection(section: ConnectionSection): SectionDefinition {
  return connectionSections.find((item) => item.id === section)!;
}

export function sectionTree(section: ConnectionSection, profiles: ConnectionProfile[], groups: string[], query: string): SectionGroup[] {
  const definition = getSection(section);
  const search = query.trim().toLocaleLowerCase();
  const members = profiles.filter(definition.matches);
  const names = [...new Set([...groups, ...members.flatMap((profile) => profile.groupId ? [profile.groupId] : [])])];
  const keys: GroupKey[] = [...names.map((name): GroupKey => ({ kind: 'named', name })), { kind: 'ungrouped' }];
  return keys.map((key) => ({ key, profiles: members.filter((profile) =>
    profile.groupId === (key.kind === 'named' ? key.name : null)
      && (!search || `${profile.name} ${profile.groupId ?? ''} ${profileDetail(profile)}`.toLocaleLowerCase().includes(search)),
  ) })).filter((group) => !search || group.profiles.length > 0);
}

export function groupKeyId(key: GroupKey): string {
  return key.kind === 'named' ? `group:${key.name}` : 'ungrouped';
}

export function profileDetail(profile: ConnectionProfile): string {
  return profile.kind === 'database' ? engineLabel(profile.engine)
    : profile.kind === 'ssh' ? `${profile.username}@${profile.host}`
      : profile.protocol === 's3' ? `${profile.bucket} · ${profile.region}`
        : `${profile.username}@${profile.host} · ${profile.protocol.toUpperCase()}`;
}

export function engineLabel(engine: string): string {
  const labels: Record<string, string> = { mysql: 'MySQL / MariaDB', postgres: 'PostgreSQL', sqlserver: 'SQL Server', oracle: 'Oracle', sqlite: 'SQLite', mongodb: 'MongoDB', redis: 'Redis', memcached: 'Memcached' };
  return labels[engine] ?? engine;
}
