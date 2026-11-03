import { ConnectorRegistry } from './connector-registry.js';
import { MysqlAdapter } from './mysql/mysql-adapter.js';
import { PostgresAdapter } from './postgres/postgres-adapter.js';
import { SqlServerAdapter } from './sqlserver/sqlserver-adapter.js';
import { OracleAdapter } from './oracle/oracle-adapter.js';
import { SqliteAdapter } from './sqlite/sqlite-adapter.js';
import { MongoAdapter } from './mongodb/mongodb-adapter.js';
import { RedisAdapter } from './redis/redis-adapter.js';
import { MemcachedAdapter } from './memcached/memcached-adapter.js';

export function createConnectorRegistry(): ConnectorRegistry {
  return new ConnectorRegistry({ mysql: new MysqlAdapter(), postgres: new PostgresAdapter(), sqlserver: new SqlServerAdapter(), oracle: new OracleAdapter(), sqlite: new SqliteAdapter(), mongodb: new MongoAdapter(), redis: new RedisAdapter(), memcached: new MemcachedAdapter() });
}
