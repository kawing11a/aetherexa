# SSH and SFTP file workspace implementation plan

> **For agentic workers:** Follow this plan task by task. The user asked to fix the remote directory listing error and add Terminal/SFTP tabs, a local-left and remote-right browser, in-app and operating-system drag-and-drop, and remote context actions.

**Goal:** Make SSH SFTP browsing start at the server's working directory and add a safe split-pane file manager with transfers, external drag-and-drop, details, rename, delete, and archive creation.

**Architecture:** Keep the authenticated SSH transport in `SshSessionManager` and make `SftpSessionManager` own one file workspace and bounded job queue per SFTP channel. Expose strict typed operations through IPC and preload. Keep local filesystem access, SFTP streams, archive streams, transfer progress, and native drag leases in the main process. Keep the xterm instance mounted while the SSH workspace switches between its inner tabs.

**Tech stack:** Electron, React, TypeScript, Zod, `ssh2`, and the pinned MIT `archiver` dependency for ZIP, TAR, and TAR.GZ.

## Global constraints

- Do not expose SSH clients, credentials, native filesystem APIs, absolute local paths, or temporary drag paths to renderer code.
- Validate each IPC payload and verify the SFTP workspace owner before dispatching an operation.
- Start remote browsing from `realpath('.')`; if REALPATH is unsupported, keep a server-home-relative location. Do not silently replace it with `/`.
- Preserve SFTP status codes and provide path-aware errors for list, stat, transfer, archive, rename, and delete failures.
- Bound each listing to 10,000 entries and recursive jobs to depth 64 and 10,000 entries.
- Do not follow symbolic links during recursive transfer or archive jobs.
- Run one file job per workspace and at most two file jobs across the application. Cap the pending queue at 100 jobs per workspace.
- Do not retry mutations automatically. Report incomplete or partial targets after cancellation and failure.
- Stage remote OS drag sources before native drag starts. Retain used stage files for 24 hours before startup cleanup.
- Do not install packages or run shell commands on remote hosts.
- Do not add or run tests. Use typecheck, build, diff checks, and direct UI inspection only.

## File map

- `src/shared/sftp-workspace.ts`: file-workspace locations, entries, jobs, results, and API types.
- `src/shared/sftp-validation.ts`: strict schemas and request bounds.
- `src/shared/database.ts`: keep SSH/terminal contracts and generic provider progress; remove replaced SFTP wire declarations after migration.
- `src/main/sftp/sftp-session-manager.ts`: SFTP workspace ownership, canonical locations, listing, mutations, and job lifecycle.
- `src/main/sftp/local-file-access.ts`: local root selection, bounded listing, containment checks, streams, and staged-file cleanup.
- `src/main/sftp/file-jobs.ts`: recursive transfers, archive creation, cancellation, progress, and partial outcomes.
- `src/main/files/sftp-provider.ts` and `src/main/files/provider-contracts.ts`: return a server-resolved initial path and preserve SFTP list errors for standalone SFTP profiles.
- `src/main/ipc/ssh-handlers.ts`: validate file-workspace calls and native drag events.
- `src/preload/index.ts`: expose typed APIs, convert dropped `File` objects to main-process paths, and subscribe to scoped job events.
- `src/renderer/workspaces/SshWorkspace.tsx`: add Terminal and SFTP files tabs.
- `src/renderer/workspaces/ssh/SshTerminalPane.tsx`: preserve xterm lifecycle and refit it when visible.
- `src/renderer/workspaces/sftp/SftpWorkspace.tsx`: own both pane snapshots, request revisions, selection, jobs, and context actions.
- `src/renderer/workspaces/sftp/FilePane.tsx`: render a pane and emit selection, open, drag, drop, and context-menu events.
- `src/renderer/workspaces/sftp/FileDetailsDialog.tsx` and `FileContextMenu.tsx`: display metadata and accessible actions.
- `src/renderer/styles/database-workspaces.css`: style the tabs, split panes, path bars, drop targets, context menu, dialogs, and progress.
- `docs/user-guide.md` and `docs/dependencies.md`: describe the file workflows and archive dependency.

## Task 1: Add SFTP workspace contracts and home-aware listing

Define discriminated local and remote directory references, entry references, page snapshots, error categories, job states, drag leases, and workspace API methods in `src/shared/sftp-workspace.ts`. Add strict input schemas in `src/shared/sftp-validation.ts`. Update `SftpSessionManager.open()` to resolve `realpath('.')` and return the remote initial snapshot. If status 8 reports unsupported REALPATH, list `.` and retain a server-home-relative anchor. Update `list()` to return canonical paths, report truncation, and map SFTP status to a safe error while preserving the numeric status. Apply the same narrow starting-path and error mapping to standalone SFTP provider sessions; keep FTP, FTPS, S3, and their workspaces unchanged.

**Check:** `npm run typecheck` and `git diff --check` pass. Source review confirms that `.` is not normalized to `/` and error code/message information remains available to the UI.

## Task 2: Add local browsing behind the main-process boundary

Create `LocalFileAccess` in the main process. Start the local root at the user's home directory and allow selecting another directory through an Electron directory dialog. Return local pages with root ID, relative path, file type, size, and modified time. Use `lstat`, reject traversal outside the selected root, do not follow symlinks, and cap each page at 10,000 entries. Keep absolute local paths inside the main process except for a dropped file path extracted in preload and sent directly to the trusted handler.

**Check:** `npm run typecheck` and `git diff --check` pass. Source review confirms that local write destinations are checked against their selected root.

## Task 3: Add session-owned transfer jobs

Extend the SFTP workspace manager with a per-workspace queue, active job, recent job events, and temporary-path registry. Assign each job a request ID, job ID, source and destination references, operation, progress, abort controller, and partial-target list. Process jobs sequentially per workspace with a global concurrency limit of two. Support regular files and directory trees in both directions. Reject invalid Windows destination names, conflicts without an explicit decision, and symlink traversal. Write new files to exclusive temporary sibling paths, publish only after a successful stream, and report any temporary target that cannot be removed. Emit events with SFTP ID, job ID, and monotonic sequence.

**Check:** `npm run typecheck` and `git diff --check` pass. Source review follows a selected local file through a pane transfer and an OS drop to its final destination.

## Task 4: Add native drag-in, drag-out, and remote actions

Use `webUtils.getPathForFile()` in preload for Explorer drops and send the resulting paths directly to the owner-checked upload handler. For native drag-out, local pane entries resolve to local paths in the main process. Remote entries are downloaded into a unique app-owned temporary directory by a cancellable job; issue an opaque ready lease only after the complete export exists. Call `webContents.startDrag()` from the native `dragstart` bridge only for a ready, unexpired lease owned by the sender. On startup, remove only app-owned staged directories older than 24 hours. Add SFTP `lstat` details, basename-only rename, delete, and directory creation. Confirm destructive actions and destination replacement in the main process.

**Check:** `npm run typecheck` and `git diff --check` pass. Source review confirms that the renderer receives no temporary paths and no native drag can start from a partial download.

## Task 5: Add archive creation

Inspect and pin the current MIT `archiver` release compatible with the bundled Node runtime. Add its type declarations if the package does not ship types. Create ZIP, TAR, and TAR.GZ streams in `file-jobs.ts`. Enumerate remote sources with bounded traversal and `lstat`; append regular-file read streams to the archive; stream archive bytes to an exclusive remote temporary file; then publish the sibling result. Exclude the output archive from its input tree. Abort source and output streams together. Report failed sources and unremoved partial paths. Do not add archive extraction or remote shell/package-manager commands.

**Check:** `npm run typecheck`, `npm run build`, and `git diff --check` pass. Inspect `package.json`, lockfile, and `docs/dependencies.md` to confirm exact versions and MIT license.

## Task 6: Add Terminal/SFTP tabs and split-pane UI

Move xterm setup and cleanup into `SshTerminalPane.tsx`, keeping one mounted terminal instance and calling fit/resize when the Terminal tab becomes visible. Add Terminal and SFTP files tabs under the SSH header. In the Files tab, render the local pane on the left and remote pane on the right with independent paths, sort order, selection, busy state, request revision, and errors. Use single click for selection and double click to open a directory or file. Support drag and drop between panes and from Explorer. Add keyboard-accessible context menus and details dialog. Show progress, cancel, partial-target, staged-drag, and retry states. Keep paths and feedback in the existing palette and type scale.

**Check:** `npm run typecheck`, `npm run build`, and `git diff --check` pass. Start the local app and inspect the no-connection, terminal, SFTP panes, and narrow-width layouts without connecting to a saved profile.

## Task 7: Document and verify the delivered workflows

Update `docs/user-guide.md` with path error handling, pane transfers, Explorer drag and drop, archive creation, deletion and overwrite confirmations, symlink behavior, recursive limits, and prepared remote drag. Update `docs/dependencies.md` with Archiver's exact version, license, and purpose. Review the final diff and run `npm run typecheck`, `npm run build`, and `git diff --check`.

**Check:** All three commands exit successfully. Do not run automated tests or open saved SSH profiles. Report the live SFTP status and OS drag behavior as unverified if no disposable server is available.

