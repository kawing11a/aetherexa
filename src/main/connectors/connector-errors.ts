import type { AppError, Result } from '@shared/contracts';
export class ConnectorError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) { super(message); this.name = 'ConnectorError'; }
}
export function ok<T>(value: T): Result<T> { return { ok: true, value }; }
export function normalizeConnectorError(error: unknown): AppError {
  if (error instanceof ConnectorError) return { code: error.code, message: error.message, retryable: error.retryable };
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code).toUpperCase() : '';
  if (/AUTH|ACCESS_DENIED|28P01|18456|ORA-01017|BAD_AUTH/.test(code)) return { code: 'authentication-failed', message: 'The server rejected the saved credentials.', retryable: false };
  if (/TLS|CERT|SSL|UNABLE_TO_VERIFY/.test(code)) return { code: 'tls-failed', message: 'The secure connection could not be established.', retryable: false };
  if (/TIMEOUT|ETIMEDOUT/.test(code)) return { code: 'timeout', message: 'The server did not respond before the operation timed out.', retryable: true };
  if (/ECONN|ENOTFOUND|EHOST|EPIPE|SOCKET|NETWORK|CONNECTION/.test(code)) return { code: 'network-failed', message: 'The server connection failed.', retryable: true };
  return { code: 'server-response', message: 'The server rejected the operation or returned an unsupported response.', retryable: false };
}
export async function capture<T>(operation: () => Promise<T>): Promise<Result<T>> {
  try { return ok(await operation()); } catch (error) { return { ok: false, error: normalizeConnectorError(error) }; }
}
