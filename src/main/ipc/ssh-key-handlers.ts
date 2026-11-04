import { dialog, ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { AppError, Result } from '@shared/contracts';
import type { SshKeyManager } from '@main/ssh/ssh-key-manager.js';
import { assertTrustedSender } from './trusted-sender.js';

const empty = z.object({}).strict();
const label = z.string().trim().min(1).max(80);
const passphrase = z.string().max(4096).optional();
const fingerprint = z.string().regex(/^SHA256:[A-Za-z0-9+/]{20,}=?$/);

export function registerSshKeyHandlers(window: BrowserWindow, keys: SshKeyManager): void {
  register('ssh-keys:list', empty, () => keys.list());
  register('ssh-keys:import', z.object({ label, passphrase, defaultPath: z.string().max(4096).optional() }).strict(), async (input) => {
    const picked = await dialog.showOpenDialog(window, { title: 'Import SSH private key', properties: ['openFile'], ...(input.defaultPath ? { defaultPath: input.defaultPath } : {}) });
    if (picked.canceled || !picked.filePaths[0]) throw new Error('cancelled');
    const bytes = await readFile(picked.filePaths[0]);
    return keys.importPrivateKey({ label: input.label, privateKey: bytes, ...(input.passphrase ? { passphrase: input.passphrase } : {}) });
  });
  register('ssh-keys:generate', z.object({ label, algorithm: z.enum(['ed25519', 'rsa']), passphrase }).strict(), (input) => keys.generate(input));
  register('ssh-keys:rename', z.object({ fingerprint, label }).strict(), (input) => keys.rename(input.fingerprint, input.label));
  register('ssh-keys:change-passphrase', z.object({ fingerprint, passphrase: z.string().max(4096) }).strict(), (input) => keys.changePassphrase(input.fingerprint, input.passphrase));
  register('ssh-keys:remove', z.object({ fingerprint }).strict(), async (input) => { await keys.remove(input.fingerprint); return undefined; });
  register('ssh-keys:export-public', z.object({ fingerprint }).strict(), async (input) => {
    const key = (await keys.list()).find((item) => item.fingerprint === input.fingerprint);
    if (!key) throw new Error('missing-key');
    const picked = await dialog.showSaveDialog(window, { title: 'Export SSH public key', defaultPath: `${key.label.replace(/[^\w.-]/g, '_')}.pub`, filters: [{ name: 'SSH public key', extensions: ['pub'] }] });
    if (picked.canceled || !picked.filePath) return undefined;
    await writeFile(picked.filePath, `${key.publicKey}\n`, 'utf8');
    return undefined;
  });

  function register<T, V>(channel: string, schema: z.ZodType<T>, operation: (input: T) => V | Promise<V>): void {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, raw: unknown) => {
      try {
        assertTrustedSender(event, window);
        return { ok: true, value: await operation(schema.parse(raw)) } satisfies Result<Awaited<V>>;
      } catch (error) {
        const safeError: AppError = error instanceof z.ZodError
          ? { code: 'invalid-input', message: 'Check the SSH key details and try again.', retryable: false }
          : error instanceof Error && error.message === 'cancelled'
            ? { code: 'cancelled', message: 'The operation was cancelled.', retryable: false }
            : error instanceof Error && error.message.includes('used by a saved SSH profile')
              ? { code: 'key-in-use', message: error.message, retryable: false }
              : error instanceof Error && error.message.includes('passphrase')
                ? { code: 'invalid-key', message: 'The key could not be read. Check the passphrase and try again.', retryable: false }
                : { code: 'ssh-key-operation-failed', message: 'The SSH key operation could not be completed.', retryable: false };
        return { ok: false, error: safeError } satisfies Result<never>;
      }
    });
  }
}
