import type { ConnectionProfile } from '@shared/profiles';
import { SqlWorkspace } from './sql/SqlWorkspace.js';
import { MongoWorkspace } from './mongodb/MongoWorkspace.js';
import { RedisWorkspace } from './redis/RedisWorkspace.js';
import { MemcachedWorkspace } from './memcached/MemcachedWorkspace.js';
import { SshWorkspace } from './SshWorkspace.js';
import { FilesWorkspace } from './FilesWorkspace.js';

export function WorkspaceRouter({ profile }: { profile: ConnectionProfile }) {
  if (profile.kind === 'ssh') return <SshWorkspace profile={profile} />;
  if (profile.kind === 'file-transfer') return <FilesWorkspace profile={profile} />;
  switch (profile.engine) {
    case 'mysql': case 'postgres': case 'sqlserver': case 'oracle': case 'sqlite': return <SqlWorkspace profile={profile} />;
    case 'mongodb': return <MongoWorkspace profile={profile} />;
    case 'redis': return <RedisWorkspace profile={profile} />;
    case 'memcached': return <MemcachedWorkspace profile={profile} />;
  }
}
