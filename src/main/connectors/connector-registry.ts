import type { DatabaseEngine } from '@shared/profiles';
import { ConnectorError } from './connector-errors.js';
import type { DatabaseAdapter, DatabaseAdapterMap } from './contracts.js';

export class ConnectorRegistry {
  private readonly adapters: ReadonlyMap<DatabaseEngine, DatabaseAdapter>;
  constructor(adapters: DatabaseAdapterMap) {
    this.adapters = new Map(Object.entries(adapters).filter((entry): entry is [DatabaseEngine, DatabaseAdapter] => entry[1] !== undefined));
  }
  get(engine: DatabaseEngine): DatabaseAdapter {
    const adapter = this.adapters.get(engine);
    if (!adapter) throw new ConnectorError('unsupported-engine', 'The ' + engine + ' connector is unavailable.');
    return adapter;
  }
}
