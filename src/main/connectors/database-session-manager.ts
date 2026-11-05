import { randomUUID } from 'node:crypto';
import type { ConnectionProfile, DatabaseEngine } from '@shared/profiles';
import type { DatabaseSessionDescriptor, DocumentPage, KeyPage, MemcachedSetInput, MemcachedValue, MongoFindInput, Namespace, DatabaseObject, QueryPage, RedisReply, TableIdentifier, TablePageRequest, TableChange, TableChangePreview, ApplyTableChange, RowInsert, RowUpdate, RowDelete } from '@shared/database';
import type { Result } from '@shared/contracts';
import { ConnectorError, normalizeConnectorError } from './connector-errors.js';
import type { DatabaseSession, MemcachedSession, MongoSession, RedisSession, SqlSession, SqlTableOperations, SqlTableChangePlan } from './contracts.js';
import type { ConnectorRegistry } from './connector-registry.js';
import type { ProfileStore } from '../storage/profile-store.js';
import type { SecretStore } from '../storage/secret-store.js';

const TABLE_PLAN_TTL_MS = 5 * 60_000;
const MAX_PENDING_TABLE_PLANS = 16;
type PendingTablePlan = { ownerId: number; change: TableChange; plan: SqlTableChangePlan; expiresAt: number };
type SessionEntry = { ownerId: number; profileId: string; descriptor: DatabaseSessionDescriptor; session: DatabaseSession; queue: Promise<void>; operations: Map<string, AbortController>; tablePlans: Map<string, PendingTablePlan> };
export class DatabaseSessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  constructor(private readonly profiles: ProfileStore, private readonly secrets: SecretStore, private readonly connectors: ConnectorRegistry) {}

  async connect(ownerId: number, profileId: string): Promise<Result<DatabaseSessionDescriptor>> {
    try {
      const profiles = await this.profiles.list();
      const profile = profiles.find((item): item is Extract<ConnectionProfile, { kind: 'database' }> => item.id === profileId && item.kind === 'database');
      if (!profile) throw new ConnectorError('profile-not-found', 'The database profile could not be found.');
      const secrets = await this.secrets.get(profile.id, profile.secretRevision) ?? {};
      const connected = await this.connectors.get(profile.engine).connect(profile, secrets);
      if (!connected.ok) return connected;
      const sessionId = randomUUID();
      const kind = connected.value.kind;
      const descriptor: DatabaseSessionDescriptor = { sessionId, profileId, engine: profile.engine, kind, capabilities: connected.value.capabilities, endpointLabel: describeEndpoint(profile) };
      this.sessions.set(sessionId, { ownerId, profileId, descriptor, session: connected.value, queue: Promise.resolve(), operations: new Map(), tablePlans: new Map() });
      return { ok: true, value: descriptor };
    } catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
  }

  async close(ownerId: number, sessionId: string): Promise<Result<void>> {
    const entry = this.owned(ownerId, sessionId);
    if (!entry.ok) return entry;
    this.sessions.delete(sessionId);
    entry.value.tablePlans.clear();
    for (const controller of entry.value.operations.values()) controller.abort();
    await entry.value.queue;
    try { await entry.value.session.close(); return { ok: true, value: undefined }; }
    catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
  }

  async cancel(ownerId: number, sessionId: string, operationId: string): Promise<Result<void>> {
    const entry = this.owned(ownerId, sessionId);
    if (!entry.ok) return entry;
    const controller = entry.value.operations.get(operationId);
    if (!controller) return { ok: false, error: { code: 'operation-not-running', message: 'The request is no longer running.', retryable: false } };
    controller.abort();
    this.sessions.delete(sessionId);
    entry.value.tablePlans.clear();
    for (const pending of entry.value.operations.values()) pending.abort();
    await entry.value.queue;
    try { await entry.value.session.close(); } catch { /* The request outcome remains uncertain. */ }
    return { ok: false, error: { code: 'completion-unknown', message: 'The request was cancelled and the connection closed. Check the server before repeating a write.', retryable: false } };
  }

  async listNamespaces(ownerId: number, id: string): Promise<Result<Namespace[]>> {
    const found = this.owned(ownerId, id);
    if (!found.ok) return found;
    const session = found.value.session;
    if (session.kind === 'sql' || session.kind === 'mongodb') return this.serialized(found.value, () => session.listNamespaces());
    return { ok: false, error: { code: 'unsupported-feature', message: 'This connection has no namespace browser.', retryable: false } };
  }
  async listObjects(ownerId: number, id: string, namespace: string): Promise<Result<DatabaseObject[]>> {
    const found = this.owned(ownerId, id); if (!found.ok) return found;
    const session = found.value.session;
    if (session.kind === 'sql' || session.kind === 'mongodb') return this.serialized(found.value, () => session.listObjects(namespace));
    return { ok: false, error: { code: 'unsupported-feature', message: 'This connection has no object browser.', retryable: false } };
  }
  runSql(ownerId: number, id: string, operationId: string, sql: string, limit: number) { return this.runWithSignal(ownerId, id, operationId, 'sql', (session, signal) => session.runSql(sql, limit, signal)); }
  findDocuments(ownerId: number, id: string, query: MongoFindInput) { return this.run(ownerId, id, 'mongodb', (session) => session.findDocuments(query)); }
  scanKeys(ownerId: number, id: string, pattern: string, cursor: string, count: number) { return this.run(ownerId, id, 'redis', (session) => session.scanKeys(pattern, cursor, count)); }
  executeRedis(ownerId: number, id: string, tokens: string[]) { return this.run(ownerId, id, 'redis', (session) => session.executeCommand(tokens)); }
  getMemcachedStats(ownerId: number, id: string) { return this.run(ownerId, id, 'memcached', (session) => session.getStats()); }
  getMemcachedValue(ownerId: number, id: string, key: string) { return this.run(ownerId, id, 'memcached', (session) => session.getValue(key)); }
  setMemcachedValue(ownerId: number, id: string, value: MemcachedSetInput) { return this.run(ownerId, id, 'memcached', (session) => session.setValue(value)); }
  deleteMemcachedValue(ownerId: number, id: string, key: string) { return this.run(ownerId, id, 'memcached', (session) => session.deleteValue(key)); }

  describeTable(ownerId: number, id: string, table: TableIdentifier) { return this.runTable(ownerId, id, (tables) => tables.describeTable(table)); }
  listColumnTypes(ownerId: number, id: string) { return this.runTable(ownerId, id, (tables) => tables.listColumnTypes()); }
  readTablePage(ownerId: number, id: string, request: TablePageRequest) { return this.runTable(ownerId, id, (tables) => tables.readTablePage(request)); }
  insertRow(ownerId: number, id: string, input: RowInsert) { return this.runTable(ownerId, id, (tables) => tables.insertRow(input)); }
  updateRow(ownerId: number, id: string, input: RowUpdate) { return this.runTable(ownerId, id, (tables) => tables.updateRow(input)); }
  deleteRow(ownerId: number, id: string, input: RowDelete) { return this.runTable(ownerId, id, (tables) => tables.deleteRow(input)); }

  previewTableChange(ownerId: number, id: string, change: TableChange): Promise<Result<TableChangePreview>> {
    return this.runTable<TableChangePreview>(ownerId, id, async (tables, entry) => {
      const requestedChange = structuredClone(change);
      const result = await tables.planTableChange(structuredClone(requestedChange));
      if (!result.ok) return result;
      if (this.sessions.get(id) !== entry) return this.unavailable();
      this.pruneTablePlans(entry);
      while (entry.tablePlans.size >= MAX_PENDING_TABLE_PLANS) {
        const oldest = entry.tablePlans.keys().next();
        if (oldest.done) break;
        entry.tablePlans.delete(oldest.value);
      }
      const planId = randomUUID();
      const plan = structuredClone(result.value);
      plan.destructive = plan.destructive || requestedChange.kind === 'rename-column' || requestedChange.kind === 'drop-column';
      entry.tablePlans.set(planId, { ownerId, change: requestedChange, plan, expiresAt: Date.now() + TABLE_PLAN_TTL_MS });
      return { ok: true, value: { planId, statements: [...plan.statements], destructive: plan.destructive } };
    });
  }

  applyTableChange(ownerId: number, id: string, input: ApplyTableChange): Promise<Result<void>> {
    return this.runTable<void>(ownerId, id, async (tables, entry) => {
      this.pruneTablePlans(entry);
      const pending = entry.tablePlans.get(input.planId);
      if (!pending || pending.ownerId !== ownerId) return { ok: false, error: { code: 'table-plan-unavailable', message: 'Preview this table change again before applying it.', retryable: false } };
      if (pending.plan.destructive && !input.confirmDestructive) return { ok: false, error: { code: 'confirmation-required', message: 'Confirm the destructive table change before applying it.', retryable: false } };
      entry.tablePlans.clear();
      return tables.applyTableChange(pending.plan);
    });
  }

  private pruneTablePlans(entry: SessionEntry): void {
    const now = Date.now();
    for (const [id, pending] of entry.tablePlans) if (pending.expiresAt <= now) entry.tablePlans.delete(id);
  }

  private async runTable<T>(ownerId: number, id: string, operation: (tables: SqlTableOperations, entry: SessionEntry) => Promise<Result<T>>): Promise<Result<T>> {
    const found = this.owned(ownerId, id);
    if (!found.ok) return found;
    const entry = found.value;
    if (entry.session.kind !== 'sql') return { ok: false, error: { code: 'wrong-session-kind', message: 'This operation requires a SQL connection.', retryable: false } };
    const tables = entry.session.tables;
    if (!tables) return { ok: false, error: { code: 'unsupported-feature', message: 'Table operations are unavailable for this connection.', retryable: false } };
    return this.serialized<T>(entry, () => {
      if (entry.ownerId !== ownerId) return Promise.resolve(this.unavailable());
      return operation(tables, entry);
    });
  }

  async closeProfile(profileId: string): Promise<void> { await Promise.all([...this.sessions.entries()].filter(([, entry]) => entry.profileId === profileId).map(([id, entry]) => this.close(entry.ownerId, id))); }
  async closeOwner(ownerId: number): Promise<void> { await Promise.all([...this.sessions.entries()].filter(([, entry]) => entry.ownerId === ownerId).map(([id]) => this.close(ownerId, id))); }
  async closeAll(): Promise<void> { await Promise.all([...this.sessions.entries()].map(([id, entry]) => this.close(entry.ownerId, id))); }

  private owned(ownerId: number, sessionId: string): Result<SessionEntry> {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.ownerId !== ownerId) return { ok: false, error: { code: 'session-not-found', message: 'The database session is closed or unavailable.', retryable: false } };
    return { ok: true, value: entry };
  }

  private async run<T, K extends 'any' | DatabaseSession['kind']>(ownerId: number, id: string, kind: K, operation: (session: SessionFor<K>) => Promise<Result<T>>): Promise<Result<T>> {
    const found = this.owned(ownerId, id);
    if (!found.ok) return found;
    if (kind !== 'any' && found.value.session.kind !== kind) return { ok: false, error: { code: 'wrong-session-kind', message: 'This operation is not supported by the active connection.', retryable: false } };
    return this.serialized(found.value, () => operation(found.value.session as SessionFor<K>));
  }

  private async runWithSignal<T>(ownerId: number, id: string, operationId: string, kind: 'sql', operation: (session: SqlSession, signal: AbortSignal) => Promise<Result<T>>): Promise<Result<T>> {
    const found = this.owned(ownerId, id);
    if (!found.ok) return found;
    if (found.value.session.kind !== kind) return { ok: false, error: { code: 'wrong-session-kind', message: 'This operation is not supported by the active connection.', retryable: false } };
    if (found.value.operations.has(operationId)) return { ok: false, error: { code: 'duplicate-operation', message: 'This request is already running.', retryable: false } };
    const controller = new AbortController();
    found.value.operations.set(operationId, controller);
    try { return await this.serialized(found.value, () => operation(found.value.session as SqlSession, controller.signal)); }
    catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
    finally { found.value.operations.delete(operationId); }
  }

  private unavailable(): Result<never> {
    return { ok: false, error: { code: 'session-not-found', message: 'The database session is closed or unavailable.', retryable: false } };
  }

  private async serialized<T>(entry: SessionEntry, operation: () => Promise<Result<T>>): Promise<Result<T>> {
    const previous = entry.queue;
    let release: () => void = () => {};
    entry.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.sessions.get(entry.descriptor.sessionId) !== entry) return this.unavailable();
      return await operation();
    } catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
    finally { release(); }
  }
}

type SessionFor<K> = K extends 'any' ? DatabaseSession : K extends 'sql' ? SqlSession : K extends 'mongodb' ? MongoSession : K extends 'redis' ? RedisSession : K extends 'memcached' ? MemcachedSession : never;
function describeEndpoint(profile: Extract<ConnectionProfile, { kind: 'database' }>): string {
  if (profile.engine === 'sqlite') return String(profile.options.path ?? 'SQLite file');
  const host = String(profile.options.host ?? '');
  const port = profile.options.port ? ':' + String(profile.options.port) : '';
  return host + port;
}
