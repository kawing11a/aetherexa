import type { BrowserWindow, WebContents } from 'electron';
import type { FileTransferProfile, SecretBundle } from '@shared/profiles';
import type { Result } from '@shared/contracts';
import type { RemoteEntry } from '@shared/files';
import type { TransferProgress } from '@shared/database';

export type FileProviderContext = { profile: FileTransferProfile; secrets: SecretBundle; ownerId: number; window: BrowserWindow; webContents: WebContents };
export type RemoteFileProfile = Extract<FileTransferProfile, { host: string }>;
export type RemoteFileProviderContext = Omit<FileProviderContext, 'profile'> & { profile: RemoteFileProfile };
export interface FileProviderSession {
  readonly profile: FileTransferProfile;
  readonly initialPath?: string;
  list(path: string): Promise<Result<RemoteEntry[]>>;
  makeDirectory(path: string): Promise<Result<void>>;
  remove(path: string, directory: boolean): Promise<Result<void>>;
  upload(path: string): Promise<Result<TransferProgress>>;
  download(path: string): Promise<Result<TransferProgress>>;
  close(): void;
}
export interface FileProvider { connect(context: FileProviderContext): Promise<Result<FileProviderSession>>; }
