import type { AppError, Result } from './contracts.js';
import type { HostKeyNotice, TransferProgress } from './database.js';

export type RemoteEntry = { name: string; type: 'file' | 'directory' | 'link' | 'other'; size: number | null; modifiedAt: number | null };
export type FileSessionDescriptor = { sessionId: string; profileId: string; protocol: string; host: string; initialPath: string };
export interface FilesApi {
  connect(input: { profileId: string }): Promise<Result<FileSessionDescriptor>>;
  disconnect(input: { sessionId: string }): Promise<Result<void>>;
  list(input: { sessionId: string; path: string }): Promise<Result<RemoteEntry[]>>;
  makeDirectory(input: { sessionId: string; path: string }): Promise<Result<void>>;
  remove(input: { sessionId: string; path: string; directory: boolean }): Promise<Result<void>>;
  upload(input: { sessionId: string; path: string }): Promise<Result<TransferProgress>>;
  download(input: { sessionId: string; path: string }): Promise<Result<TransferProgress>>;
  reviewHostKey(input: { requestId: string; accept: boolean; replaceChangedKey?: boolean }): Promise<Result<void>>;
  onHostKey(listener: (notice: HostKeyNotice) => void): () => void;
  onTransferProgress(listener: (event: TransferProgress) => void): () => void;
}
export type FileOperationError = AppError;
