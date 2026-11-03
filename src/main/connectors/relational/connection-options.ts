import { ConnectorError } from '../connector-errors.js';
import type { DatabaseProfile } from '@shared/profiles';
import type { SecretBundle } from '@shared/profiles';

export function requiredHost(profile: DatabaseProfile): string {
  const host = profile.options.host;
  if (typeof host !== 'string' || !host.trim()) throw new ConnectorError('invalid-input', 'A server host is required.');
  return host.trim();
}
export function requiredPort(profile: DatabaseProfile, fallback: number): number {
  const value = profile.options.port ?? fallback;
  const port = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConnectorError('invalid-input', 'The server port is invalid.');
  return port;
}
export function requiredUsername(profile: DatabaseProfile): string {
  const username = profile.options.username;
  if (typeof username !== 'string' || !username.trim()) throw new ConnectorError('invalid-input', 'A username is required.');
  return username.trim();
}
export function password(secrets: SecretBundle): string | undefined { return secrets.password; }
export function optionalDatabase(profile: DatabaseProfile): string | undefined {
  const value = profile.options.database;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
export function tlsEnabled(profile: DatabaseProfile): boolean { return profile.options.tls !== false; }
export function sqlitePath(profile: DatabaseProfile): string {
  const value = profile.options.path;
  if (typeof value !== 'string' || !value.trim()) throw new ConnectorError('invalid-input', 'A SQLite file path is required.');
  return value.trim();
}
