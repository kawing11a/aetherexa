import type { SFTPWrapper } from 'ssh2';

type StatusError = { code?: number; message?: string };

export function initialRemotePath(sftp: Pick<SFTPWrapper, 'realpath'>): Promise<string> {
  return new Promise((resolve, reject) => sftp.realpath('.', (error, absolutePath) => {
    if (!error && absolutePath) { resolve(absolutePath); return; }
    if (error && [6, 7].includes(statusCode(error) ?? -1)) { reject(error); return; }
    resolve('.');
  }));
}

export function sftpErrorMessage(operation: string, path: string, error: unknown): string {
  const status = statusCode(error);
  const reason = status === 2 ? 'the path was not found'
    : status === 3 ? 'the server denied access'
      : status === 6 || status === 7 ? 'the SFTP connection was lost'
        : status === 8 ? 'the server does not support this operation'
          : status === undefined ? safeDetail(error) : `the server returned SFTP status ${status}`;
  return `The remote ${operation} failed for ${path || '.'}: ${reason}.`;
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as StatusError).code;
  return typeof code === 'number' ? code : undefined;
}

function safeDetail(error: unknown): string {
  if (!error || typeof error !== 'object' || !('message' in error)) return 'the server did not provide a status';
  const message = (error as StatusError).message;
  if (typeof message !== 'string') return 'the server did not provide a status';
  const detail = message.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
  return detail || 'the server did not provide a status';
}
