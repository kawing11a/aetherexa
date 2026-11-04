# Aetherexa profile directory and SSH key manager implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Let users choose one shared directory for connection profile metadata and manage SSH private keys locally without entering key paths in connection forms.

**Architecture:** Store the selected profile directory setting under the normal Aetherexa `userData` path, then read/write `profiles.json` in the selected directory using the existing atomic JSON pattern. Store SSH key metadata and `safeStorage`-encrypted key material under `userData`; profiles refer to a key by its SHA-256 public-key fingerprint. Preserve legacy path-based profiles until the user explicitly imports the key.

**Tech Stack:** Electron 45 `safeStorage` and dialogs, TypeScript, React, Zod, existing `ssh2` key utilities, current JSON stores.

## Global Constraints

- The selected connection directory is shared by database, SSH, and future file-transfer profiles.
- The custom directory contains non-secret profile metadata only; passwords, passphrases, AWS secret access keys, and SSH private-key contents stay in local `safeStorage` storage.
- Existing profiles remain in their current directory until the user changes it.
- Existing path-based SSH profiles keep working until the user explicitly imports a key into the manager.
- Never delete, move, or modify an imported source private-key file.
- Private-key bytes never cross into the renderer. Secret values may exist briefly in a form while the user enters them, then go only through validated IPC and are cleared after submission; never persist them in local storage, profile metadata, logs, or error messages.

---

### Task 1: Add persistent profile-directory settings

**Files:**
- Create: `src/main/storage/connection-directory-store.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/storage/profile-store.ts`

**Interfaces:**
- `ConnectionDirectoryStore.getDirectory(): string` returns the currently selected profile directory, defaulting to the existing `userData` location.
- `ConnectionDirectoryStore.setDirectory(path: string): Promise<Result<{ directory: string; profileCount: number }>>` validates and migrates before switching.
- `ProfileStore` receives `ConnectionDirectoryStore` at construction and dynamically stores `profiles.json` in its selected directory.

- [x] Add a Zod-validated settings record under `app.getPath('userData')` containing only the selected profile-directory path.
- [x] Initialize the directory store before `ProfileStore`; keep `SecretStore` and `KnownHostsStore` on the normal `userData` directory.
- [x] Move `ProfileStore.filePath` from a constructor field initializer to a constructor argument resolved by `ConnectionDirectoryStore`.
- [x] Keep the existing default path and profiles schema so current users do not migrate unless they select a new directory.
- [x] Expose typed `get`, `choose`, and `set` connection-directory methods over preload APIs, with trusted-sender checks and strict empty/path request schemas.
- [x] Run `npm run typecheck` and `npm run build`.

### Task 2: Migrate profiles into a selected directory without overwriting

**Files:**
- Modify: `src/main/storage/connection-directory-store.ts`
- Modify: `src/main/storage/profile-store.ts`
- Modify: `src/main/ipc/profile-handlers.ts`
- Modify: `src/shared/contracts.ts`

**Interfaces:**
- `ConnectionDirectoryStore.setDirectory(path)` reads the current profile list, validates the target store, writes the merged result atomically, and updates the active setting only after successful write.

- [x] Normalize the chosen path with `resolve`, create the directory after user selection, and reject a path that is a file or inaccessible.
- [x] If the target has no `profiles.json`, atomically copy the validated current profiles there and retain the source file.
- [x] If the target has profiles, merge by profile ID; keep identical duplicates once and reject conflicting duplicate IDs with a safe error that leaves both files and the active setting unchanged.
- [x] If parsing or writing fails, leave the active directory and source data unchanged; return a user-safe failure result.
- [x] Return the new directory and migrated profile count only after the settings record commits successfully.
- [ ] Run `npm run typecheck` and verify with a temporary directory containing an empty store, a matching store, and a conflicting profile ID using a small manual Node script or isolated app data.

### Task 3: Define the SSH key record and encrypted store

**Files:**
- Modify: `src/shared/profiles.ts`
- Modify: `src/main/storage/secret-store.ts`
- Create: `src/main/storage/ssh-key-store.ts`
- Create: `src/main/ssh/ssh-key-manager.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- `SshKeyMetadata` contains `fingerprint: string`, `label: string`, `algorithm: 'ed25519' | 'rsa'`, `publicKey: string`, and `createdAt: string`.
- `SshKeyManager.list(): Promise<SshKeyMetadata[]>` returns metadata only.
- `SshKeyManager.importPrivateKey(input: { label: string; privateKey: Buffer; passphrase?: string }): Promise<SshKeyMetadata>` parses the key, derives its OpenSSH public key/fingerprint, and stores private material in `SecretStore`.
- `SshKeyManager.generate(input: { label: string; algorithm: 'ed25519' | 'rsa'; passphrase?: string }): Promise<SshKeyMetadata>` generates and stores a key pair.
- `SshKeyManager.getPrivateKey(fingerprint: string): Promise<{ privateKey: Buffer; passphrase?: string }>` is main-process-only.

- [x] Store metadata in an atomic JSON file under `userData`; store private key and passphrase in a `SecretStore` entry keyed by a UUID, never by the renderer-provided fingerprint alone.
- [x] Derive SHA-256 fingerprints from the parsed OpenSSH public key, and use the fingerprint as the stable profile reference.
- [x] Use `ssh2.utils.generateKeyPairSync('ed25519')` by default and `ssh2.utils.generateKeyPairSync('rsa', { bits: 4096 })` for the compatibility option; encrypt a supplied passphrase through the existing `SecretStore`.
- [x] Parse imported encrypted/unencrypted OpenSSH private keys with `ssh2.utils.parseKey`, reject malformed or unsupported keys before writing, and preserve the source file.
- [x] Validate labels, algorithms, key sizes, fingerprints, and metadata record shape with Zod; do not put private-key fields in profile schemas or JSON metadata.
- [x] Run `npm run typecheck` and `npm run build`.

### Task 4: Add validated key-manager IPC

**Files:**
- Create: `src/main/ipc/ssh-key-handlers.ts`
- Modify: `src/main/ipc/register-handlers.ts`
- Modify: `src/shared/contracts.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- `ProductivityApi.sshKeys.list(): Promise<Result<SshKeyMetadata[]>>`
- `ProductivityApi.sshKeys.import(input: { label: string; passphrase?: string }): Promise<Result<SshKeyMetadata>>` opens a native private-key file picker; key bytes do not pass through renderer IPC.
- `ProductivityApi.sshKeys.generate(input): Promise<Result<SshKeyMetadata>>`
- `ProductivityApi.sshKeys.rename(input: { fingerprint: string; label: string }): Promise<Result<SshKeyMetadata>>`
- `ProductivityApi.sshKeys.remove(input: { fingerprint: string }): Promise<Result<void>>`
- `ProductivityApi.sshKeys.exportPublic(input: { fingerprint: string }): Promise<Result<void>>` opens a native save dialog and writes a `.pub` file.

- [x] Check every IPC sender against the current trusted window and validate each request with a strict Zod schema.
- [x] Open key-file and public-key save dialogs in the main process; read source key bytes and write public key output in the main process. Accept a passphrase as transient form input over validated IPC, never return or log it, and clear it after the import response.
- [x] Return only metadata and safe generic errors; never return decrypted private key data or passphrases.
- [x] Reject deleting a key referenced by an SSH/SFTP profile unless the UI has confirmed and removed those references first.
- [x] Run `npm run typecheck` and `npm run build`.

### Task 5: Add the key manager UI and profile selection

**Files:**
- Create: `src/renderer/components/SshKeyManagerDialog.tsx`
- Modify: `src/renderer/components/AppShell.tsx`
- Modify: `src/renderer/components/ProfileDialog.tsx`
- Modify: `src/shared/profiles.ts`
- Modify: `src/main/ssh/ssh-session-manager.ts`
- Modify: `src/renderer/styles/app-shell.css`

**Interfaces:**
- New SSH profiles use `keyFingerprint?: string`; legacy `privateKeyPath?: string` remains accepted for existing profiles.
- `SshSessionManager.buildConfig` resolves a key by fingerprint first, otherwise reads the legacy `privateKeyPath` as before.

- [x] Add a Settings entry to list keys, import a key, generate Ed25519 or RSA-4096, rename a key, copy its public key, export its public key, and show its fingerprint/type.
- [x] Add a key selector and **Manage keys** action to SSH connection editing; the generated key selected in the manager is returned to the open connection form.
- [x] For legacy profiles, keep the existing key path and offer **Import key into manager**; after import succeeds, save the returned fingerprint while retaining the original file.
- [x] Validate key references when saving profiles and when building SSH client authentication config.
- [x] Update profile deletion and key-manager removal flows so referenced key material cannot be silently orphaned or deleted.
- [ ] Run `npm run typecheck` and `npm run build`; open the packaged local app with isolated `UNIFIED_PRODUCTIVITY_DATA_DIR` and verify import/generate/select/rename/copy/export plus a legacy-path profile still loads.

### Task 6: Add connection-directory controls to Settings

**Files:**
- Modify: `src/renderer/components/AppShell.tsx`
- Create: `src/renderer/components/SettingsDialog.tsx`
- Create: `src/main/ipc/connection-directory-handlers.ts`
- Modify: `src/main/ipc/register-handlers.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/contracts.ts`
- Modify: `docs/user-guide.md`
- Modify: `docs/security-and-credentials.md`

**Interfaces:**
- Settings displays `{ directory: string; profileCount: number }` and allows the user to choose and confirm a new directory using a main-process folder picker.

- [x] Add a folder picker backed by Electron `dialog.showOpenDialog` with `properties: ['openDirectory', 'createDirectory']` and pass only the chosen directory to the validated migration IPC.
- [x] Show the current directory and a short note that profile metadata is stored there while credentials and key material remain local and encrypted.
- [x] Require a confirmation that explains merge behavior if the chosen directory already contains Aetherexa profiles; preserve both files on conflict.
- [x] Refresh the profile list after a successful change and retain the old directory display after a failed change.
- [x] Document selection, merge/conflict behavior, cloud-sync metadata implications, and local-only credential/key storage.
- [ ] Run `npm run typecheck` and `npm run build`, then verify switching from a seeded profile directory to an empty directory and back without changing stored secrets.

## Handoff

Complete this foundation phase before the standalone SFTP/FTP plan. Keep the earlier uncommitted `src/renderer/styles/app-shell.css` search-label fix separate from profile-directory/key-manager commits.
