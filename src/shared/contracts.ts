export type AppError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: AppError };

export type ProfileSaveInput = {
  profile: import('./profiles.js').ConnectionProfile;
  secrets?: Record<string, string>;
};

import type { DatabaseApi, SshApi, SftpApi } from './database.js';
import type { FilesApi } from './files.js';

export interface ProductivityApi {
  database: DatabaseApi;
  ssh: SshApi;
  sftp: SftpApi;
  files: FilesApi;
  app: {
    getVersion(): Promise<Result<string>>;
    getUpdateStatus(): Promise<Result<UpdateStatus>>;
    checkForUpdates(): Promise<Result<UpdateStatus>>;
    installUpdate(): Promise<Result<void>>;
    onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
  };
  profiles: {
    list(): Promise<Result<import('./profiles.js').ConnectionProfile[]>>;
    save(input: ProfileSaveInput): Promise<Result<void>>;
    remove(id: string): Promise<Result<void>>;
  };
  connectionDirectory: {
    get(): Promise<Result<{ directory: string }>>;
    choose(): Promise<Result<string | null>>;
    set(input: { directory: string }): Promise<Result<{ directory: string; profileCount: number }>>;
  };
  sshKeys: {
    list(): Promise<Result<import('./profiles.js').SshKeyMetadata[]>>;
    import(input: { label: string; passphrase?: string; defaultPath?: string }): Promise<Result<import('./profiles.js').SshKeyMetadata>>;
    generate(input: { label: string; algorithm: 'ed25519' | 'rsa'; passphrase?: string }): Promise<Result<import('./profiles.js').SshKeyMetadata>>;
    rename(input: { fingerprint: string; label: string }): Promise<Result<import('./profiles.js').SshKeyMetadata>>;
    changePassphrase(input: { fingerprint: string; passphrase: string }): Promise<Result<void>>;
    remove(input: { fingerprint: string }): Promise<Result<void>>;
    exportPublic(input: { fingerprint: string }): Promise<Result<void>>;
  };
}

export type UpdateStatus = {
  state: 'unsupported' | 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'error';
  message: string;
};

declare global {
  interface Window {
    productivityApi: ProductivityApi;
  }
}
