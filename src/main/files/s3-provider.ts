import { randomUUID } from 'node:crypto';
import { basename, posix } from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { dialog } from 'electron';
import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { TransferProgress } from '@shared/database';
import type { Result } from '@shared/contracts';
import type { RemoteEntry } from '@shared/files';
import type { FileProvider, FileProviderContext, FileProviderSession } from './provider-contracts.js';

const MAX_LIST_ENTRIES = 10_000;
const DELETE_BATCH_SIZE = 1000;

export class S3Provider implements FileProvider {
  async connect(context: FileProviderContext): Promise<Result<FileProviderSession>> {
    if (context.profile.protocol !== 's3') return fail('wrong-provider', 'This connection does not use AWS S3.');
    const { profile } = context;
    if (profile.credentialMode === 'static' && (!context.secrets.accessKeyId || !context.secrets.secretAccessKey)) return fail('missing-credentials', 'Add both static AWS access keys or choose the default credential chain.');
    const client = new S3Client({ region: profile.region, ...(profile.credentialMode === 'static' ? { credentials: { accessKeyId: context.secrets.accessKeyId!, secretAccessKey: context.secrets.secretAccessKey! } } : {}) });
    return { ok: true, value: createSession(context, client) };
  }
}

function createSession(context: FileProviderContext, client: S3Client): FileProviderSession {
  if (context.profile.protocol !== 's3') throw new Error('Wrong provider.');
  const profile = context.profile; const activeUploads = new Set<AbortController>();
  return {
    profile,
    close() { for (const controller of activeUploads) controller.abort(); activeUploads.clear(); client.destroy(); },
    async list(path) {
      const normalized = prefixPath(path); if (!normalized.ok) return normalized;
      const prefix = normalized.value ? `${normalized.value}/` : '';
      const entries = new Map<string, RemoteEntry>(); let token: string | undefined;
      try {
        do {
          const page = await client.send(new ListObjectsV2Command({ Bucket: profile.bucket, Prefix: prefix || undefined, Delimiter: '/', MaxKeys: 1000, ContinuationToken: token }));
          for (const item of page.CommonPrefixes ?? []) {
            if (!item.Prefix) continue;
            const name = item.Prefix.slice(prefix.length).replace(/\/$/, '');
            if (name) entries.set(name, { name, type: 'directory', size: null, modifiedAt: null });
          }
          for (const item of page.Contents ?? []) {
            if (!item.Key || item.Key === prefix) continue;
            if (item.Key.endsWith('/')) {
              const folderName = item.Key.slice(prefix.length).replace(/\/$/, '');
              if (folderName && !folderName.includes('/')) entries.set(folderName, { name: folderName, type: 'directory', size: null, modifiedAt: null });
              continue;
            }
            const name = item.Key.slice(prefix.length);
            if (!name || name.includes('/')) continue;
            entries.set(name, { name, type: 'file', size: item.Size ?? null, modifiedAt: item.LastModified?.getTime() ?? null });
          }
          token = page.IsTruncated ? page.NextContinuationToken : undefined;
          if (entries.size > MAX_LIST_ENTRIES) return fail('listing-too-large', 'This folder contains too many items to display. Open a narrower prefix.');
        } while (token);
        return { ok: true, value: [...entries.values()].sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1) };
      } catch (error) { return fail('s3-list-failed', safeAwsError(error)); }
    },
    async makeDirectory(path) {
      const normalized = prefixPath(path); if (!normalized.ok) return normalized;
      if (!normalized.value) return fail('invalid-path', 'The bucket root cannot be created as a folder.');
      try { await client.send(new PutObjectCommand({ Bucket: profile.bucket, Key: `${normalized.value}/`, Body: new Uint8Array(0) })); return { ok: true, value: undefined }; }
      catch (error) { return fail('s3-mkdir-failed', safeAwsError(error)); }
    },
    async remove(path, directory) {
      const normalized = prefixPath(path); if (!normalized.ok) return normalized;
      if (!normalized.value) return fail('invalid-path', 'The bucket root cannot be deleted.');
      if (!directory) {
        try { await client.send(new DeleteObjectCommand({ Bucket: profile.bucket, Key: normalized.value })); return { ok: true, value: undefined }; }
        catch (error) { return fail('s3-delete-failed', safeAwsError(error)); }
      }
      const prefix = `${normalized.value}/`; let token: string | undefined;
      try {
        do {
          const page = await client.send(new ListObjectsV2Command({ Bucket: profile.bucket, Prefix: prefix, MaxKeys: DELETE_BATCH_SIZE, ContinuationToken: token }));
          const objects = (page.Contents ?? []).flatMap((item) => item.Key ? [{ Key: item.Key }] : []);
          if (objects.length) {
            const deleted = await client.send(new DeleteObjectsCommand({ Bucket: profile.bucket, Delete: { Objects: objects, Quiet: true } }));
            if (deleted.Errors?.length) return fail('s3-delete-failed', 'Some objects could not be deleted. Check bucket permissions and retry.');
          }
          token = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (token);
        return { ok: true, value: undefined };
      } catch (error) { return fail('s3-delete-failed', safeAwsError(error)); }
    },
    async upload(path) {
      const destination = prefixPath(path); if (!destination.ok) return destination;
      const picked = await dialog.showOpenDialog(context.window, { properties: ['openFile'], title: 'Choose a file to upload' });
      if (picked.canceled || !picked.filePaths[0]) return fail('transfer-cancelled', 'The upload was cancelled.');
      const localPath = picked.filePaths[0]; const isDirectory = path.endsWith('/') || !destination.value; const key = isDirectory ? `${destination.value ? `${destination.value}/` : ''}${basename(localPath)}` : destination.value;
      let total: number; try { total = (await stat(localPath)).size; } catch { return fail('transfer-read-failed', 'The selected file could not be read.'); }
      try {
        await client.send(new HeadObjectCommand({ Bucket: profile.bucket, Key: key }));
        const confirmation = await dialog.showMessageBox(context.window, { type: 'warning', title: 'Replace S3 object?', message: 'An object with this key already exists.', detail: key, buttons: ['Replace', 'Cancel'], defaultId: 1, cancelId: 1 });
        if (confirmation.response !== 0) return fail('transfer-cancelled', 'The upload was cancelled.');
      } catch (error) { if (!isNotFound(error)) return fail('s3-check-failed', safeAwsError(error)); }
      const controller = new AbortController(); activeUploads.add(controller);
      const transferId = randomUUID(); const fileName = basename(localPath); let transferred = 0;
      const send = (bytes: number, state: TransferProgress['state']) => { if (!context.webContents.isDestroyed()) context.webContents.send('files:transfer-progress', { transferId, direction: 'upload', fileName, transferredBytes: bytes, totalBytes: total, state } satisfies TransferProgress); };
      try {
        const upload = new Upload({ client, params: { Bucket: profile.bucket, Key: key, Body: createReadStream(localPath) }, queueSize: 4, partSize: 8 * 1024 * 1024, leavePartsOnError: false, abortController: controller });
        upload.on('httpUploadProgress', (event) => { transferred = event.loaded ?? transferred; send(transferred, 'running'); });
        await upload.done(); send(total, 'completed');
        return { ok: true, value: { transferId, direction: 'upload', fileName, transferredBytes: total, totalBytes: total, state: 'completed' } };
      } catch (error) { send(transferred, 'failed'); return fail('s3-upload-failed', safeAwsError(error)); }
      finally { activeUploads.delete(controller); }
    },
    async download(path) {
      const source = prefixPath(path); if (!source.ok) return source;
      if (!source.value || source.value.endsWith('/')) return fail('invalid-path', 'Choose an S3 object to download.');
      const destination = await dialog.showSaveDialog(context.window, { title: 'Save downloaded S3 object', defaultPath: basename(source.value) });
      if (destination.canceled || !destination.filePath) return fail('transfer-cancelled', 'The download was cancelled.');
      const transferId = randomUUID(); const fileName = basename(source.value); let total: number | null = null; let transferred = 0;
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: profile.bucket, Key: source.value })); total = response.ContentLength ?? null;
        if (!response.Body) return fail('s3-download-failed', 'The S3 object did not return file content.');
        const send = (bytes: number, state: TransferProgress['state']) => { if (!context.webContents.isDestroyed()) context.webContents.send('files:transfer-progress', { transferId, direction: 'download', fileName, transferredBytes: bytes, totalBytes: total, state } satisfies TransferProgress); };
        const body = Readable.fromWeb(response.Body.transformToWebStream() as unknown as import('node:stream/web').ReadableStream);
        const meter = new Transform({ transform(chunk: Buffer, _encoding, done) { transferred += chunk.length; send(transferred, 'running'); done(null, chunk); } });
        await pipeline(body, meter, createWriteStream(destination.filePath)); send(transferred, 'completed');
        return { ok: true, value: { transferId, direction: 'download', fileName, transferredBytes: transferred, totalBytes: total, state: 'completed' } };
      } catch (error) { await rm(destination.filePath, { force: true }).catch(() => undefined); return fail('s3-download-failed', safeAwsError(error)); }
    },
  };
}

function prefixPath(input: string): Result<string> { if (input.includes('\0') || input.split('/').some((part) => part === '..')) return fail('invalid-path', 'The S3 path is invalid.'); return { ok: true, value: input.replace(/^\/+/, '').replace(/\/{2,}/g, '/').replace(/\/$/, '') }; }
function isNotFound(error: unknown): boolean { return typeof error === 'object' && error !== null && '$metadata' in error && typeof error.$metadata === 'object' && error.$metadata !== null && 'httpStatusCode' in error.$metadata && error.$metadata.httpStatusCode === 404; }
function safeAwsError(error: unknown): string { if (typeof error === 'object' && error !== null && 'name' in error && (error.name === 'AccessDenied' || error.name === 'InvalidAccessKeyId' || error.name === 'SignatureDoesNotMatch')) return 'AWS denied this operation. Check the selected credentials and bucket permissions.'; if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'NoSuchBucket') return 'The bucket could not be found in the selected region.'; if (error instanceof Error && /timeout|network/i.test(error.message)) return 'The AWS endpoint could not be reached. Check your network and try again.'; return 'The S3 operation could not be completed. Check the bucket, region, credentials, and permissions.'; }
function fail<T = never>(code: string, message: string, retryable = false): Result<T> { return { ok: false, error: { code, message, retryable } }; }
