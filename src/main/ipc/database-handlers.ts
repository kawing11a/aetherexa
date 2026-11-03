import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { z } from 'zod';
import type { DatabaseSessionManager } from '@main/connectors/database-session-manager';
import type { AppError, Result } from '@shared/contracts';
import { databaseConnectSchema, databaseCloseSchema, namespaceListSchema, objectListSchema, runSqlSchema, findDocumentsSchema, scanKeysSchema, redisCommandSchema, memcachedStatsSchema, memcachedKeySchema, memcachedSetSchema } from '@shared/database-validation';
import { assertTrustedSender } from './trusted-sender.js';

export function registerDatabaseHandlers(window: BrowserWindow, sessions: DatabaseSessionManager): void {
  register(window, 'database:connect', databaseConnectSchema, (owner, input) => sessions.connect(owner, input.profileId));
  register(window, 'database:close', databaseCloseSchema, (owner, input) => sessions.close(owner, input.sessionId));
  register(window, 'database:cancel', z.object({ sessionId: z.string().uuid(), operationId: z.string().uuid() }).strict(), (owner, input) => sessions.cancel(owner, input.sessionId, input.operationId));
  register(window, 'database:list-namespaces', namespaceListSchema, (owner, input) => sessions.listNamespaces(owner, input.sessionId));
  register(window, 'database:list-objects', objectListSchema, (owner, input) => sessions.listObjects(owner, input.sessionId, input.namespace));
  register(window, 'database:run-sql', runSqlSchema.extend({ operationId: z.string().uuid() }), (owner, input) => sessions.runSql(owner, input.sessionId, input.operationId, input.sql, input.limit));
  register(window, 'database:find-documents', findDocumentsSchema, (owner, input) => sessions.findDocuments(owner, input.sessionId, input.query));
  register(window, 'database:scan-keys', scanKeysSchema, (owner, input) => sessions.scanKeys(owner, input.sessionId, input.pattern, input.cursor, input.count));
  register(window, 'database:execute-redis', redisCommandSchema, (owner, input) => sessions.executeRedis(owner, input.sessionId, input.tokens));
  register(window, 'database:memcached-stats', memcachedStatsSchema, (owner, input) => sessions.getMemcachedStats(owner, input.sessionId));
  register(window, 'database:memcached-get', memcachedKeySchema, (owner, input) => sessions.getMemcachedValue(owner, input.sessionId, input.key));
  register(window, 'database:memcached-set', memcachedSetSchema, (owner, input) => sessions.setMemcachedValue(owner, input.sessionId, input.value));
  register(window, 'database:memcached-delete', memcachedKeySchema, (owner, input) => sessions.deleteMemcachedValue(owner, input.sessionId, input.key));
  window.webContents.once('destroyed', () => { void sessions.closeOwner(window.webContents.id); });
}

function register<T>(window: BrowserWindow, channel: string, schema: z.ZodType<T>, operation: (owner: number, input: T) => Promise<unknown>): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (event, rawInput: unknown) => {
    try {
      assertTrustedSender(event, window);
      return await operation(event.sender.id, schema.parse(rawInput));
    } catch (error) {
      const safeError: AppError = error instanceof z.ZodError
        ? { code: 'invalid-input', message: 'Check the request details and try again.', retryable: false }
        : error instanceof Error && error.message === 'Untrusted IPC sender'
          ? { code: 'untrusted-sender', message: 'This request was rejected.', retryable: false }
          : { code: 'database-operation-failed', message: 'The database operation could not be completed.', retryable: false };
      return { ok: false, error: safeError } satisfies Result<never>;
    }
  });
}
