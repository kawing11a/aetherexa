# Aetherexa standalone SFTP and FTP/FTPS implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` and complete each checkbox in order. This is Phase 2 and depends on `2026-11-03-aetherexa-profile-directory-and-key-manager.md`.

**Goal:** Add a Files navigation entry that browses and transfers files over independently saved SFTP and FTP/FTPS connections, with no SSH terminal required.

**Architecture:** Define one typed file-provider API and one file-browser UI. Main-process provider managers own network clients and transfer streams. Each connection is a `file-transfer` profile with its own protocol and credentials; SFTP creates a direct SSH transport and reuses host-key review, SSH agent support, and the Phase 1 key manager. FTP uses `basic-ftp` in passive mode and enforces TLS certificate validation for FTPS. Existing SSH-terminal SFTP remains functional during this phase.

**Tech Stack:** Electron, TypeScript, React, Zod, existing `ssh2` and `safeStorage` stores, `basic-ftp`.

## Shared contracts

- Add `FileTransferProfile` to `src/shared/profiles.ts` as a `kind: 'file-transfer'` variant with `protocol: 'sftp' | 'ftp' | 'ftps-explicit' | 'ftps-implicit'`, UUID `id`, name, nullable group, host, port, username, and `secretRevision`. SFTP has `authentication: 'password' | 'key-manager' | 'agent'`, optional `keyFingerprint`, and optional legacy-independent host-key data reference; FTP variants use password authentication only. Keep all secret values out of this schema.
- Store password and optional SFTP password-auth secret bundles in `SecretStore` keyed by profile ID and revision. SFTP key/passphrase resolves through Phase 1 `SshKeyManager`; SSH agent authentication uses the same agent resolution as `SshSessionManager`.
- Add provider-neutral `RemoteEntry` (`name`, `type`, `size`, `modifiedAt`) and `FileTransferProgress` types. Progress includes operation ID, direction, file name, byte counts, and running/completed/failed state.
- Add `ProductivityApi.files` methods: `connect({profileId})`, `disconnect({sessionId})`, `list({sessionId,path})`, `makeDirectory({sessionId,path})`, `remove({sessionId,path,directory})`, `upload({sessionId,path})`, `download({sessionId,path})`, `reviewHostKey({requestId,accept,replaceChangedKey?})`, and `onTransferProgress(listener)`. Use one shared session ID namespace and return only descriptors/metadata.
- Use strict Zod schemas for every request, trusted-window checks for every handler, safe generic provider errors, and main-process dialogs for local file selection/save paths. Never return connection credentials, private keys, or raw library/network errors.

### Task 1: Add the profile and file-provider model

**Files:**
- Modify: `src/shared/profiles.ts`
- Modify: `src/shared/database.ts`
- Modify: `src/shared/database-validation.ts`
- Modify: `src/shared/contracts.ts`
- Modify: `src/main/storage/profile-store.ts`
- Modify: `src/main/ipc/profile-handlers.ts`

- [x] Add strict schemas and types for SFTP, FTP, explicit FTPS, and implicit FTPS profiles; validate protocol-specific authentication and port ranges, while allowing conventional ports to default in the form.
- [x] Add `file-transfer` to the discriminated profile union and ensure profile save/list, delete, secret revision handling, and profile-directory migration accept this variant.
- [x] Keep SFTP key references as Phase 1 fingerprints and keep profile metadata secret-free; validate key references at save/connect time.
- [x] Run `npm run typecheck` and `npm run build`.

### Task 2: Implement direct SFTP transport and lifecycle

**Files:**
- Create: `src/main/files/file-session-manager.ts`
- Create: `src/main/files/sftp-provider.ts`
- Modify: `src/main/ssh/ssh-session-manager.ts`
- Modify: `src/main/ssh/known-hosts-store.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/ipc/register-handlers.ts`

- [x] Define a `FileProviderSession` interface with `list`, `makeDirectory`, `remove`, `upload`, `download`, and `close`; the manager owns provider session IDs and enforces the creating renderer owner on every operation.
- [x] Add `SftpFileProvider` that establishes an SSH client directly from the file-transfer profile without opening a terminal or depending on an SSH terminal profile/session.
- [x] Reuse Phase 1 key-manager/private-key and SSH-agent resolution; read password-auth secrets only in main. Handle SSH host-key review through the existing known-host store and trust/change notice flow before enabling SFTP operations.
- [x] Move/reuse remote path validation and file listing semantics from `SftpSessionManager`; report safe names, type, size, and modified time. Keep existing terminal-coupled `SftpSessionManager` operations working.
- [x] Enforce session cleanup on disconnect, profile deletion, renderer destruction, app shutdown, and connection error; pending transfers must stop and emit a terminal progress state.
- [ ] Run typecheck/build and manually verify a saved SFTP profile connects and browses with the SSH terminal closed, including first-use and changed-host-key review.

### Task 3: Implement FTP and FTPS provider

**Files:**
- Add dependency: `basic-ftp`
- Create: `src/main/files/ftp-provider.ts`
- Modify: `src/main/files/file-session-manager.ts`
- Modify: `src/main/ipc/register-handlers.ts`
- Modify: `src/shared/profiles.ts`

- [x] Use `basic-ftp` passive transfer behavior; support plain FTP, explicit FTPS, and implicit FTPS profile modes and their standard default ports.
- [x] Require normal TLS certificate and hostname validation for both FTPS modes; do not offer an insecure-certificate override.
- [x] Show a renderer confirmation before plain FTP connects explaining that credentials and file contents are unencrypted; do not persist a one-time confirmation as a hidden security bypass.
- [x] Keep FTP passwords only in the local encrypted `SecretStore`; sanitize all connection and transfer errors before they reach IPC.
- [x] Implement list, directory creation, remove, upload, and download with bounded listing results, main-process file dialogs, progress events, collision handling, and safe cleanup.
- [ ] Run typecheck/build and manually verify FTP warning, explicit FTPS and implicit FTPS connections, certificate rejection, listing, upload/download, directory creation, and delete confirmation against controlled endpoints.

### Task 4: Add shared Files workspace and profile UI

**Files:**
- Modify: `src/renderer/components/AppShell.tsx`
- Modify: `src/renderer/components/ConnectionSidebar.tsx`
- Modify: `src/renderer/components/ProfileDialog.tsx`
- Modify: `src/renderer/components/WorkspaceTabs.tsx`
- Modify: `src/renderer/workspaces/WorkspaceRouter.tsx`
- Create: `src/renderer/workspaces/FilesWorkspace.tsx`
- Create: `src/renderer/components/FileTransferProfileDialog.tsx`
- Modify: `src/renderer/styles/app-shell.css`
- Modify: `src/renderer/styles/database-workspaces.css`
- Modify: `src/preload/index.ts`
- Modify: `src/main/ipc/register-handlers.ts`
- Modify: `src/shared/contracts.ts`
- Modify: `docs/user-guide.md`
- Modify: `docs/security-and-credentials.md`

- [x] Add Files navigation and a saved-profile flow that can create, edit, open, and remove SFTP/FTP/FTPS profiles while keeping database and SSH profile forms unchanged.
- [x] Add protocol-aware inputs: SFTP password, managed key selection, or SSH agent; FTP/FTPS password; host, port, username, and encryption mode. Secret form values are transient and cleared after save/connect.
- [x] Build one file browser with breadcrumb/path navigation, file name/type/size/modified time, upload/download progress, create folder, delete confirmation, connect/disconnect, host-key review, and actionable safe errors.
- [x] Provide capability-based actions: omit unsupported operations; no remote rename requirement for FTP/SFTP in this first Files workspace.
- [x] Wire strict IPC schemas, preload types, event unsubscribe behavior, owner-scoped sessions, profile-secret cleanup, and app shutdown cleanup.
- [x] Document protocols, plaintext FTP warning, FTPS certificate verification, SFTP host-key verification, and local-only encrypted secrets.
- [ ] Run typecheck/build; manually verify that Files works without opening SSH, that SSH-terminal SFTP still works, and that DB/SSH profiles and open tabs are unaffected.

## Handoff

Complete Phase 2 before adding S3. The shared file-provider interface and Files workspace must be stable so the AWS provider can use the same operations without protocol-specific renderer branches.
