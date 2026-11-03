import type { ColumnDescriptor, QueryPage, WireValue } from '@shared/database';
import { MAX_CELL_BYTES, MAX_PAGE_BYTES, MAX_RESULT_ROWS } from '../contracts.js';

export function normalizeValue(value: unknown): WireValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return { $type: 'bigint', value: value.toString() };
  if (value instanceof Date) return { $type: 'timestamp', value: value.toISOString() };
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === 'object') {
    if (value && 'toJSON' in value && typeof value.toJSON === 'function') return normalizeValue(value.toJSON());
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeValue(item)]));
  }
  return String(value);
}

export class BoundedPageBuilder {
  private readonly rows: WireValue[][] = [];
  private pageBytes = 0;
  private stopped: QueryPage['truncationReason'];
  constructor(private readonly columns: ColumnDescriptor[], private readonly rowLimit: number) {}
  push(row: unknown[]): boolean {
    if (this.rows.length >= Math.min(this.rowLimit, MAX_RESULT_ROWS)) { this.stopped = 'row-limit'; return false; }
    const normalized = row.map(normalizeValue);
    const sizes = normalized.map(estimateBytes);
    if (sizes.some((size) => size > MAX_CELL_BYTES)) { this.stopped = 'cell-limit'; return false; }
    const rowBytes = sizes.reduce((sum, size) => sum + size, 0);
    if (this.pageBytes + rowBytes > MAX_PAGE_BYTES) { this.stopped = 'page-byte-limit'; return false; }
    this.pageBytes += rowBytes;
    this.rows.push(normalized);
    return true;
  }
  finish(): QueryPage {
    return { columns: this.columns, rows: this.rows, truncated: this.stopped !== undefined, ...(this.stopped ? { truncationReason: this.stopped } : {}) };
  }
}

function estimateBytes(value: WireValue): number {
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  if (value instanceof Uint8Array) return value.byteLength;
  if (value === null || typeof value !== 'object') return 8;
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + estimateBytes(item), 2);
  return Object.entries(value).reduce((sum, [key, item]) => sum + key.length + estimateBytes(item), 2);
}
