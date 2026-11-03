import type { DatabaseEngine, DatabaseProfile, SecretBundle } from '@shared/profiles';
import type { Result } from '@shared/contracts';
import type { ConnectorCapabilities, DatabaseObject, DocumentPage, KeyPage, MemcachedSetInput, MemcachedValue, MongoFindInput, Namespace, QueryPage, RedisReply } from '@shared/database';

export type { ConnectorCapabilities, DatabaseObject, DocumentPage, KeyPage, MemcachedSetInput, MemcachedValue, MongoFindInput, Namespace, QueryPage, RedisReply } from '@shared/database';
export type { AppError, Result } from '@shared/contracts';

export const MAX_RESULT_ROWS = 10_000;
export const MAX_CELL_BYTES = 1_048_576;
export const MAX_PAGE_BYTES = 16 * 1_048_576;
export const MAX_METADATA_ITEMS = 10_000;
export const MAX_REDIS_COMMAND_BYTES = 64 * 1_024;

export type BaseSession = { engine: DatabaseEngine; capabilities: ConnectorCapabilities; close(): Promise<void> };
export type SqlSession = BaseSession & { kind: 'sql'; listNamespaces(signal?: AbortSignal): Promise<Result<Namespace[]>>; listObjects(namespace: string, signal?: AbortSignal): Promise<Result<DatabaseObject[]>>; runSql(sql: string, limit: number, signal?: AbortSignal): Promise<Result<QueryPage>> };
export type MongoSession = BaseSession & { kind: 'mongodb'; listNamespaces(signal?: AbortSignal): Promise<Result<Namespace[]>>; listObjects(database: string, signal?: AbortSignal): Promise<Result<DatabaseObject[]>>; findDocuments(input: MongoFindInput, signal?: AbortSignal): Promise<Result<DocumentPage>> };
export type RedisSession = BaseSession & { kind: 'redis'; scanKeys(pattern: string, cursor: string, count: number, signal?: AbortSignal): Promise<Result<KeyPage>>; executeCommand(tokens: string[], signal?: AbortSignal): Promise<Result<RedisReply>> };
export type MemcachedSession = BaseSession & { kind: 'memcached'; getStats(signal?: AbortSignal): Promise<Result<Record<string, string>>>; getValue(key: string, signal?: AbortSignal): Promise<Result<MemcachedValue | null>>; setValue(input: MemcachedSetInput, signal?: AbortSignal): Promise<Result<void>>; deleteValue(key: string, signal?: AbortSignal): Promise<Result<void>> };
export type DatabaseSession = SqlSession | MongoSession | RedisSession | MemcachedSession;

export interface DatabaseAdapter { readonly engine: DatabaseEngine; connect(profile: DatabaseProfile, secrets: SecretBundle): Promise<Result<DatabaseSession>> }
export type DatabaseAdapterMap = Partial<Record<DatabaseEngine, DatabaseAdapter>>;
