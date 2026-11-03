export class StorageError extends Error {
  constructor(
    readonly code: 'corrupt-store' | 'encryption-unavailable' | 'write-failed',
    message: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

export function toSafeStorageError(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof StorageError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.code === 'write-failed',
    };
  }

  return {
    code: 'storage-error',
    message: 'The local profile store could not be accessed.',
    retryable: true,
  };
}
