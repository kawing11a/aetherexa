import { MongoClient, type Document } from 'mongodb';
import type { DatabaseProfile, SecretBundle } from '@shared/profiles';
import type { Result } from '@shared/contracts';
import type { DocumentPage, WireValue } from '@shared/database';
import { ConnectorError, ok, normalizeConnectorError } from '../connector-errors.js';
import type { DatabaseAdapter, DatabaseSession, MongoSession } from '../contracts.js';
import { optionalDatabase, password, requiredHost, requiredPort, tlsEnabled } from '../relational/connection-options.js';
import { normalizeValue } from '../relational/row-normalizer.js';
import { MAX_CELL_BYTES, MAX_METADATA_ITEMS, MAX_PAGE_BYTES, MAX_RESULT_ROWS } from '../contracts.js';

const capabilities = { namespaces: true, objects: false, queryMode: 'document-filter' as const, readRows: true, exportRows: true };
export class MongoAdapter implements DatabaseAdapter {
  readonly engine = 'mongodb' as const;
  async connect(profile: DatabaseProfile, secrets: SecretBundle): Promise<Result<DatabaseSession>> {
    try {
      const username = typeof profile.options.username === 'string' && profile.options.username.trim() ? profile.options.username.trim() : undefined;
      const auth = username ? encodeURIComponent(username) + ':' + encodeURIComponent(password(secrets) ?? '') + '@' : '';
      const uri = 'mongodb://' + auth + requiredHost(profile) + ':' + requiredPort(profile, 27017) + '/' + encodeURIComponent(optionalDatabase(profile) ?? 'admin') + '?authSource=' + encodeURIComponent(String(profile.options.authSource ?? 'admin'));
      const client = new MongoClient(uri, { tls: tlsEnabled(profile), serverSelectionTimeoutMS: 10_000, connectTimeoutMS: 10_000, maxPoolSize: 2 });
      await client.connect();
      const session: MongoSession = {
        kind: 'mongodb', engine: this.engine, capabilities,
        async close() { await client.close(); },
        async listNamespaces() {
          try {
            const admin = await client.db().admin().listDatabases({ nameOnly: true, authorizedDatabases: true });
            return ok(admin.databases.slice(0, MAX_METADATA_ITEMS).map((database) => ({ name: database.name, kind: 'database' as const })));
          } catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
        },
        async listObjects(database) {
          try { const cursor = client.db(database).listCollections({}, { nameOnly: true }); const collections = []; for await (const item of cursor) { if (collections.length >= MAX_METADATA_ITEMS) break; collections.push({ name: item.name, kind: 'collection' as const }); } await cursor.close(); return ok(collections); }
          catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
        },
        async findDocuments(input, signal) {
          try {
            if (signal?.aborted) throw new ConnectorError('cancelled', 'The request was cancelled.');
            const cursor = client.db(input.database).collection<Document>(input.collection).find(input.filter as Document, { projection: input.projection, limit: Math.min(input.limit + 1, MAX_RESULT_ROWS + 1), batchSize: 64 });
            const documents: Record<string, WireValue>[] = [];
            let bytes = 0;
            let truncated = false;
            for await (const document of cursor) {
              if (signal?.aborted) { await cursor.close(); throw new ConnectorError('cancelled', 'The request was cancelled.'); }
              const value = normalizeValue(document) as Record<string, WireValue>;
              const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
              if (documents.length >= input.limit || documents.length >= MAX_RESULT_ROWS || size > MAX_CELL_BYTES || bytes + size > MAX_PAGE_BYTES) { truncated = true; break; }
              documents.push(value); bytes += size;
            }
            await cursor.close();
            return ok<DocumentPage>({ documents, truncated });
          } catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
        },
      };
      return ok<DatabaseSession>(session);
    } catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
  }
}
