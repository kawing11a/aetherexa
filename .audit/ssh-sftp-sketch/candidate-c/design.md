# Candidate C: session-owned file workspace

## Usage

`SshWorkspace` opens a file workspace on its existing authenticated SSH session. The returned snapshot gives each pane an opaque directory reference and the path to display. The renderer navigates, starts transfers, and asks for remote actions using references from snapshots. The main process owns paths, handles, jobs, archive streams, and temporary drag files.

```ts
// Connect once and render independent local and remote listings.
const opened = await api.sftpWorkspace.open({ sshSessionId: ssh.sessionId });
if (!opened.ok) return showError(opened.error);
const { workspaceId, local, remote } = opened.value;
setPanes({ local, remote });

// Drag a selected remote entry onto the local pane.
const queued = await api.sftpWorkspace.transfer({
  workspaceId,
  source: { side: 'remote', entries: [remoteEntry.ref] },
  destination: { side: 'local', directory: local.directory },
});
if (queued.ok) showJob(queued.value.jobId);

// Drop files from Explorer onto the remote pane.
// The preload extracts paths from the File objects and does not return them to the page.
const queued = await api.sftpWorkspace.uploadDropped(
  { workspaceId, destination: remote.directory },
  Array.from(event.dataTransfer.files),
);

// Context menu: create a ZIP beside the selected remote folder.
await api.sftpWorkspace.archive({ workspaceId, entry: remoteEntry.ref, format: 'zip' });
```

Remote items dragged to another application must first exist on the local filesystem. Selecting **Prepare for desktop drag** queues a download to a private temporary directory. Once the row shows **Ready to drag**, its external-drag handle calls `startNativeDrag` in the actual `dragstart` event. Ordinary row dragging continues to support the local pane. The user can drag the prepared file or folder into Explorer or the desktop; a progress message explains preparation and failures.

## Shape

### Data model and boundary

```ts
type WorkspaceId = string & { readonly __workspace: unique symbol };
type JobId = string & { readonly __job: unique symbol };
type DragId = string & { readonly __drag: unique symbol };
type LocalDirectoryRef = string & { readonly __localDirectory: unique symbol };
type RemoteDirectoryRef = string & { readonly __remoteDirectory: unique symbol };
type LocalEntryRef = string & { readonly __localEntry: unique symbol };
type RemoteEntryRef = string & { readonly __remoteEntry: unique symbol };

type FileKind = 'file' | 'directory' | 'link' | 'other';
type Entry<R> = {
  ref: R; name: string; kind: FileKind; size: number | null;
  modifiedAt: number | null; permissions: number | null;
};
type DirectorySnapshot<D, E> = {
  directory: D; displayPath: string; parent: D | null;
  entries: Entry<E>[]; truncated: boolean;
};
type LocalDirectory = DirectorySnapshot<LocalDirectoryRef, LocalEntryRef>;
type RemoteDirectory = DirectorySnapshot<RemoteDirectoryRef, RemoteEntryRef>;
type WorkspaceSnapshot = { workspaceId: WorkspaceId; local: LocalDirectory; remote: RemoteDirectory };
type TransferRequest =
  | { workspaceId: WorkspaceId; source: { side: 'local'; entries: LocalEntryRef[] }; destination: { side: 'remote'; directory: RemoteDirectoryRef } }
  | { workspaceId: WorkspaceId; source: { side: 'remote'; entries: RemoteEntryRef[] }; destination: { side: 'local'; directory: LocalDirectoryRef } };
type FileJob = {
  workspaceId: WorkspaceId; jobId: JobId; direction: 'upload' | 'download' | 'archive' | 'prepare-drag';
  state: 'queued' | 'running' | 'needs-conflict-decision' | 'completed' | 'failed' | 'cancelled';
  name: string; transferredBytes: number; totalBytes: number | null;
  message?: string; partialPaths?: string[];
};
type JobEvent = { type: 'job'; job: FileJob } | { type: 'drag-ready'; workspaceId: WorkspaceId; jobId: JobId; dragId: DragId };
type ConflictDecision = { choice: 'skip' | 'replace' } | { choice: 'rename'; newName: string };
type FileDetails = { name: string; kind: FileKind; size: number | null; modifiedAt: number | null; permissions: number | null; owner: number | null; group: number | null; linkTarget?: string };
```

The preload exposes one focused capability. Brands describe intended use; strict Zod schemas, ownership checks, and token lookup enforce it at runtime.

```ts
interface SftpWorkspaceApi {
  open(input: { sshSessionId: string }): Promise<Result<WorkspaceSnapshot>>;
  list(input: { workspaceId: WorkspaceId; directory: LocalDirectoryRef }): Promise<Result<LocalDirectory>>;
  list(input: { workspaceId: WorkspaceId; directory: RemoteDirectoryRef }): Promise<Result<RemoteDirectory>>;
  enter(input: { workspaceId: WorkspaceId; entry: LocalEntryRef }): Promise<Result<LocalDirectory>>;
  enter(input: { workspaceId: WorkspaceId; entry: RemoteEntryRef }): Promise<Result<RemoteDirectory>>;
  chooseLocalRoot(input: { workspaceId: WorkspaceId }): Promise<Result<LocalDirectory>>;
  goRemotePath(input: { workspaceId: WorkspaceId; path: string }): Promise<Result<RemoteDirectory>>;
  transfer(input: TransferRequest): Promise<Result<{ jobId: JobId }>>;
  uploadDropped(input: { workspaceId: WorkspaceId; destination: RemoteDirectoryRef }, files: File[]): Promise<Result<{ jobId: JobId }>>;
  cancelJob(input: { workspaceId: WorkspaceId; jobId: JobId }): Promise<Result<void>>;
  resolveConflict(input: { workspaceId: WorkspaceId; jobId: JobId } & ConflictDecision): Promise<Result<void>>;
  details(input: { workspaceId: WorkspaceId; entry: RemoteEntryRef }): Promise<Result<FileDetails>>;
  rename(input: { workspaceId: WorkspaceId; entry: RemoteEntryRef; name: string }): Promise<Result<void>>;
  makeDirectory(input: { workspaceId: WorkspaceId; directory: RemoteDirectoryRef; name: string }): Promise<Result<void>>;
  remove(input: { workspaceId: WorkspaceId; entry: RemoteEntryRef }): Promise<Result<void>>;
  archive(input: { workspaceId: WorkspaceId; entry: RemoteEntryRef; format: 'zip' | 'tar.gz' }): Promise<Result<{ jobId: JobId }>>;
  prepareNativeDrag(input: { workspaceId: WorkspaceId; source: { side: 'local'; entries: LocalEntryRef[] } | { side: 'remote'; entries: RemoteEntryRef[] } }): Promise<Result<{ jobId: JobId }>>;
  startNativeDrag(input: { workspaceId: WorkspaceId; dragId: DragId }): void;
  onEvent(listener: (event: JobEvent) => void): () => void;
}
```

`startNativeDrag` is the only fire-and-forget operation: preload sends a one-way IPC message from `dragstart`; main validates sender, ownership and a ready token, then immediately calls Electron `webContents.startDrag` with already-materialized paths. Electron documents this event-to-native-drag flow in its [native file drag-and-drop guide](https://www.electronjs.org/docs/latest/tutorial/native-file-drag-drop). `uploadDropped` accepts browser `File` objects, maps them to local paths in preload with [`webUtils.getPathForFile`](https://www.electronjs.org/docs/latest/api/web-utils), rejects empty paths and sends them to the main process. Main re-stats every dropped path. No renderer method accepts arbitrary local source paths. A local pane row uses a local entry reference; the path bar displays the current directory but does not make it an authority.

Main keeps one workspace per SFTP channel: owner, local root chosen by the native directory picker, remote starting location, immutable listing generations, and a bounded job registry. Each directory/entry token resolves only for that owner and workspace. An entry token is a listing snapshot, not proof that the entry is unchanged: before a transfer or mutation, main rechecks type and relevant metadata. Jobs resolve their input references at enqueue time so a later pane navigation does not invalidate an active transfer. Evict old snapshots with a bounded LRU after jobs have copied their required inputs. Session close cancels jobs, closes SFTP, revokes all references, and rejects late events.

`open` asks the SFTP server for `realpath('.')` and lists that directory. Do not prepend `/` to a server-returned path. If `realpath` is unsupported, retain a distinct relative `.` origin and build child paths relative to it; do not normalize it to `/`. If the origin cannot be listed, keep the workspace open with a remote path entry, Home/Retry controls, and a normalized cause such as permission denied, missing directory, connection lost, or server failure. The existing error discards the status, so an inaccessible `/` is a plausible cause, not a proven diagnosis. Apply the same SFTP home-path and normalized-error behavior to standalone `SftpProvider`/`FilesWorkspace` while retaining its separate session and other protocol providers.

Listings display a truncation notice rather than silently hiding entries past the existing 10,000 limit. The UI uses request revisions per pane so a slower older response cannot replace a newer selection. Local browsing begins in the user's home directory; the native directory chooser grants a new root. Navigation and recursive transfers remain within the selected root, do not follow symlinks by default, and expose inaccessible links as such. Remote `details` uses `lstat`, and recursive transfer/archive similarly does not follow links. Reject unsupported special files with an explicit per-entry outcome rather than silently omitting them.

All transfers use one bounded queue per workspace. Progress events include `workspaceId` and `jobId`, allowing multiple mounted workspaces to filter their own jobs. File and directory drops are processed recursively with bounded depth and entry counts; cancellation stops reads/writes and reports any partial artifact. Create new destinations exclusively. On collision, pause and ask whether to skip, use another name, or replace. Write replacements through a temporary sibling and only commit with an atomic replace operation the target supports; otherwise report that safe replacement is unavailable and offer a new name. Never auto-retry or silently clobber. Failure or connection loss reports whether a partial target remains.

`archive` streams remote file content into the app's pinned MIT `archiver` dependency, then streams ZIP or gzip-compressed TAR output to a new SFTP destination beside the selected item. Its [API supports stream input and gzip-compressed TAR](https://www.archiverjs.com/docs/archiver/). No shell command or remote package installation is required. Build entry names from validated SFTP names, preserve directories and supported metadata, and preserve symlinks as links when the archive format/library supports it; otherwise fail with the affected entry named. Create the archive with exclusive-create semantics and clean up a partial output when possible. If cleanup is uncertain, report the path. Protect against including the output in its own source tree, excessive recursion, and malicious names. Archive creation is in scope; extraction is a separate future action.

External drag preparation resolves selected local entries directly, or downloads selected remote files or folders to a per-workspace temporary directory with original visible names. Keep staged files for the lifetime of the app and for a bounded grace period after exit; on a later startup, remove only stale directories created by this application under its own temp root. A cancel or failed preparation cleans its own incomplete staging directory if possible. Surface the temporary copy and preparation progress. Keep OS drag separate from row drag so internal pane drops remain reliable.

### Module map

- `src/main/sftp/sftp-workspace-manager.ts`: per-owner workspace, reference registry, directory listings, file actions, and job ownership; reuses the existing SSH client and SFTP channel.
- `src/main/sftp/transfer-jobs.ts`: bounded queue, recursive local/remote transfers, conflicts, cancellation, progress and partial outcomes.
- `src/main/sftp/remote-archive.ts`: archive streaming and safe remote output creation using `archiver`.
- `src/main/sftp/native-drag.ts`: private staging, ready drag tokens, native `startDrag`, and stale-temp cleanup.
- `src/main/sftp/sftp-session-manager.ts`: SFTP channel ownership and shared remote path/status helpers; migrate old SFTP callers onto the workspace capability instead of keeping two transfer implementations.
- `src/main/files/sftp-provider.ts`: standalone SFTP home path/error fix; it stays independent of the SSH workspace transport.
- `src/shared/database.ts`, `database-validation.ts`, `src/main/ipc/ssh-handlers.ts`, `src/preload/index.ts`: serializable API, strict parsing, trusted sender/owner checks, and file-drop/native-drag bridges.
- `src/renderer/workspaces/SshWorkspace.tsx`: connection lifecycle and Terminal/SFTP tab selection. Keep the terminal mounted while hidden and refit/resize when shown.
- `src/renderer/workspaces/sftp/SftpWorkspace.tsx` and `FilePane.tsx`: two independently navigable panes, selection, drag/drop, context menu, errors and progress. Keep the local pane left and remote pane right; stack them only when width requires it.
- `src/renderer/styles/database-workspaces.css`, `docs/user-guide.md`, `docs/dependencies.md`, `package.json` and lockfile: layout, interaction guidance and pinned archive dependency.

The interface hides path resolution, token ownership, streaming, filesystem access, and conflict policy behind a small set of user-level operations. The renderer still owns view state and user decisions. The distinct source/destination union prevents a same-side transfer at compile time; runtime parsing and token ownership protect the IPC boundary.

## Problem

The current SSH view puts a terminal next to a remote-only list and always reads `/`. Its list handler discards the actual SFTP error, so the reported failure cannot be diagnosed from the message alone. The new file UI needs local filesystem access, recursive SFTP transfers, OS drag-and-drop, and remote file operations while preserving the existing owner checks, host-key flow, and isolated renderer.

## Synthesis decision

For the orchestrator to fill after comparing candidates. This candidate uses main-owned capabilities and job state rather than accepting raw local paths from the renderer.

## Tradeoffs accepted

- We accept a bounded reference registry and snapshot refreshes in exchange for not granting the renderer arbitrary local file authority.
- We accept a preparation step before dragging remote items outside the app because Electron native drag requires local files at the start of the OS drag.
- We accept bandwidth and local CPU for archive creation in exchange for portable ZIP/TAR support without changing the remote host's installed packages.
- We accept a local directory chooser to change browsing roots in exchange for a clear user-selected filesystem boundary.

## Alternatives considered

- **Raw paths through every IPC method.** This is a smaller initial diff but exposes filesystem and transfer policy to every caller. Main-process references hide those decisions and bind them to the owner and listing lifecycle.
- **Execute remote `tar` and `zip`, installing missing commands remotely.** This avoids round trips for archive data, but requires shell quoting, command availability, privilege/package-manager decisions, and remote machine changes. Streaming in the app has one portable archive implementation and a smaller public operation.
- **Unify all file providers behind the existing standalone Files workspace.** FTP/S3 do not share an SSH session or all SFTP operations; a common abstraction now would expose capability checks to the UI and risk disrupting the unrelated workspace. Keep the existing provider and the SSH-owned session separate.

## Implementation reconciliation

Record accepted deviations here before an implementation unit is handed off. No implementation decisions have been changed yet.

## Open questions and risks

- Can the target server's `realpath('.')` and the preserved status explain its current listing failure? Source inspection alone cannot establish the actual server status.
- Will Explorer accept a prepared directory drag on every supported Windows version? Verify the native interaction on Windows using disposable data; file staging and the transfer-to-local-pane action remain usable if an OS blocks directory drag-out.
- Will the server support atomic replacement? When it does not, keep the old destination intact and require a different name.
- Is the archive library's chosen version compatible with the bundled Electron/Node runtime and packaging? Pin and document the version after inspecting its package metadata.

## Next implementation step

Define the workspace and job DTOs, implement SFTP initial-directory resolution with status-preserving listing, and connect the existing SSH session to the workspace manager.
