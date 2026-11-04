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

export interface ProductivityApi {
  database: DatabaseApi;
  ssh: SshApi;
  sftp: SftpApi;
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
