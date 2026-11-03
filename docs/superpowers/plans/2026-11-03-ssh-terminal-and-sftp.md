# SSH Terminal and SFTP Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` or `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add secure local/remote terminal tabs and a two-pane SFTP browser with a transfer queue.

**Architecture:** The main process owns SSH connections and authentication. Terminal and SFTP use separate channels; they may share one authenticated transport from a single profile. The renderer receives only terminal bytes, directory entries, and transfer status through typed events.

**Tech Stack:** TypeScript, SSH2 protocol package selected after license/runtime review, xterm.js, and a Windows-compatible PTY package for local shells.

## Global Constraints

- Keep private keys and passwords in the main process and protected local storage.
- Present first-use SSH host keys and block changed-key connections until the user resolves the mismatch.
- Bound terminal scrollback, SFTP listing size, and transfer concurrency.
- Report partial transfer outcomes; do not silently discard partial files.
- No automated tests are added or run unless the user asks for testing or verification.

---

### Task 1: Add SSH profile and session service

**Files:**
- Create: `src/main/ssh/ssh-types.ts`
- Create: `src/main/ssh/ssh-profile-validation.ts`
- Create: `src/main/ssh/ssh-session-manager.ts`
- Create: `src/main/ssh/known-hosts-store.ts`
- Create: `src/main/ssh/ssh-errors.ts`
- Create: `src/main/ipc/ssh-handlers.ts`
- Modify: `src/shared/profiles.ts`
- Modify: `src/shared/contracts.ts`
- Modify: `src/main/ipc/register-handlers.ts`
- Modify: `src/main/storage/secret-store.ts`

**Interfaces:**
- `SshProfile` contains host, port, username, auth mode, optional group ID, and a known-host fingerprint reference; it contains no secret bytes.
- `SshSessionManager.open(profileId): Promise<SshSessionId>` retrieves auth material in the main process and returns a session ID only.
- `SshSessionManager.close(sessionId): Promise<void>` closes every channel and socket owned by that session.
- `SshSessionManager.onHostKey(profileId, fingerprint): Promise<'new' | 'match' | 'changed'>` gates authentication.
- `KnownHostsStore.replaceAfterReview(profileId, expectedOld, acceptedNew): Promise<void>` updates trust only after the explicit review flow confirms the displayed fingerprints.

- [ ] Add password, private-key-file, and agent authentication modes supported by the selected SSH package; do not place secret contents in profile JSON.
- [ ] Add `src/renderer/workspaces/terminal/HostKeyReviewDialog.tsx` to show the hostname, port, stored fingerprint, and newly observed fingerprint before an explicit trust update.
- [ ] Store a newly observed fingerprint only after the renderer presents the fingerprint and the user explicitly accepts it.
- [ ] Block on a changed fingerprint and surface the stored and observed fingerprints; do not add a connect-through button. Let the user replace the saved fingerprint only from an explicit review flow after confirming the new fingerprint.
- [ ] Add idle timeouts, explicit disconnect state, and deterministic cleanup of channels on app quit.

### Task 2: Add local shell and SSH terminal tabs

**Files:**
- Create: `src/main/terminal/local-shell-manager.ts`
- Create: `src/main/terminal/terminal-session-manager.ts`
- Create: `src/main/ipc/terminal-handlers.ts`
- Create: `src/renderer/workspaces/terminal/TerminalWorkspace.tsx`
- Create: `src/renderer/workspaces/terminal/TerminalPane.tsx`
- Create: `src/renderer/workspaces/terminal/terminal-fit.ts`
- Create: `src/renderer/styles/terminal.css`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/contracts.ts`
- Modify: `src/main/ipc/register-handlers.ts`

**Interfaces:**
- `TerminalSessionManager.openLocal(options): Promise<TerminalSessionId>` starts a constrained user shell with explicit working-directory and environment rules.
- `TerminalSessionManager.openSsh(sshSessionId, options): Promise<TerminalSessionId>` requests a new PTY channel on a managed SSH session.
- `TerminalSessionManager.write(id, data): Promise<void>`, `resize(id, cols, rows): Promise<void>`, `close(id): Promise<void>` operate on a single session.
- `window.productivityApi.terminal.onData(listener)` returns an unsubscribe function and never forwards Electron event objects.

- [ ] Integrate xterm.js with terminal fit and search addons selected after package review; cap retained scrollback.
- [ ] Stream terminal output using typed events and handle renderer unmount by removing listeners.
- [ ] Add multiple tabs per host, explicit local-shell launch, close confirmation only when unsent process work remains, and clear disconnect/reconnect state.
- [ ] Reject renderer requests with invalid dimensions or data larger than the configured channel limit.

### Task 3: Add SFTP directory and file operations

**Files:**
- Create: `src/main/sftp/sftp-session.ts`
- Create: `src/main/sftp/path-validation.ts`
- Create: `src/main/sftp/transfer-queue.ts`
- Create: `src/main/ipc/sftp-handlers.ts`
- Create: `src/renderer/workspaces/sftp/SftpWorkspace.tsx`
- Create: `src/renderer/workspaces/sftp/FilePane.tsx`
- Create: `src/renderer/workspaces/sftp/TransferQueue.tsx`
- Create: `src/renderer/workspaces/sftp/TransferRow.tsx`
- Create: `src/renderer/styles/sftp-workspace.css`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/contracts.ts`
- Modify: `src/main/ipc/register-handlers.ts`

**Interfaces:**
- `SftpSession.list(path, signal?): Promise<DirectoryPage>` returns names, sizes, timestamps, permissions, and file type without following links by default.
- `TransferQueue.enqueue({ sessionId, direction, localPath, remotePath }): TransferId` returns a stable ID; progress events include bytes, total bytes when known, and state.
- `TransferQueue.cancel(id): Promise<void>` stops the channel and reports whether a partial target remains.

- [ ] Implement local/remote listing, mkdir, rename, delete, upload, and download with validated paths and explicit confirmation for remote delete/overwrite.
- [ ] Render two independently navigable panes and a transfer queue with progress, cancellation, retry, and partial-file state.
- [ ] Set bounded concurrency and refuse paths outside the selected local workspace for local-side operations.
- [ ] Ensure transfer errors identify direction and path but redact secrets and never include private key contents.

### Task 4: Connect terminal and SFTP lifecycle

**Files:**
- Modify: `src/main/ssh/ssh-session-manager.ts`
- Modify: `src/main/terminal/terminal-session-manager.ts`
- Modify: `src/main/sftp/sftp-session.ts`
- Modify: `src/renderer/components/AppShell.tsx`
- Modify: `src/renderer/components/WorkspaceTabs.tsx`
- Modify: `src/renderer/components/ConnectionSidebar.tsx`

**Interfaces:**
- Workspace descriptors reference `sshSessionId` without exposing the underlying socket or auth context.
- Closing a terminal tab closes its PTY channel; closing the host workspace closes SFTP channels, transfer jobs, terminal channels, and the SSH transport in that order.

- [ ] Add host profiles to the shared sidebar and open Terminal or SFTP tabs from one host selection.
- [ ] Share a connection only when the same profile and authentication context are in use; never reuse a session after host-key state changes.
- [ ] Show an explicit warning when disconnecting will cancel active transfers and let the user keep the session open instead.
- [ ] On app shutdown, cancel jobs and close transports with bounded deadlines so the process can exit cleanly.

