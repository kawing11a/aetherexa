# Candidate A: one owned SFTP file workspace

## Usage (caller's view)

Open an SSH profile and switch between **Terminal** and **SFTP files** below the connection header. The terminal stays connected while the Files tab shows a local directory on the left and the server's starting directory on the right. Single click selects an entry, double click opens a directory, and dragging between panes copies files or directories. Drops from Explorer into the remote pane upload the dropped items.

Right click a remote entry for Download, Rename, Details, Create TAR, Create TAR.GZ, Create ZIP, Copy path, and Delete. Right click empty space for New folder and Refresh. Archive creation installs an application dependency during development and streams archive data through the application; it requires no remote shell or remote package installation. Archive extraction is outside this request's chosen scope.

For external downloads, **Prepare to drag outside** stages the selected remote files or directories and shows progress. When complete, a **Drag to Explorer** handle starts native file drag. A fresh drag gesture is required after staging. Local entries can use that handle immediately. This makes large remote downloads visible and cancellable without downloading files merely because the user selected them. Ordinary row dragging remains available for immediate transfers between the two application panes.

The renderer calls a small file-workspace API. It does not construct remote paths, orchestrate recursive copies, or hold native filesystem handles.

```ts
// SshWorkspace opens the file workspace on the existing SSH transport.
const opened = await api.sftp.open({ sshSessionId });
if (opened.ok) {
  setWorkspace(opened.value);
  dispatch({ type: 'initial-pages', local: opened.value.local, remote: opened.value.remote });
}
```

```ts
// A remote row dropped into the current local directory starts one owned job.
const queued = await api.sftp.enqueue({
  sftpId,
  work: { kind: 'download', sources: selectedRemoteEntries, destination: localPage.location },
});
if (!queued.ok) showError(queued.error);

const unsubscribe = api.sftp.onJob((event) => {
  if (event.sftpId === sftpId) dispatch({ type: 'job', event });
});
```

```ts
// Drop imports are resolved inside preload; absolute dropped paths never return to UI.
await api.sftp.uploadDropped({ sftpId, destination: remotePage.location }, [...event.dataTransfer.files]);

// A ready export lease belongs to this session and renderer. The handler runs on dragstart.
function dragPreparedFiles(event: React.DragEvent, lease: ExportLease) {
  event.preventDefault();
  api.sftp.startNativeDrag({ sftpId, leaseId: lease.id });
}
```

## Problem

The current `SshWorkspace` opens an SFTP channel and immediately lists `/`. `SftpSessionManager.open()` returns no starting directory, and `validateRemotePath('.')` rewrites `.` to `/`. The list error handler discards the SFTP status and server message. Root-directory permissions are a plausible cause of the user's error, but the actual server reason remains unobserved. Transfers currently open native dialogs and run inside individual manager methods, so the renderer has no contract for local browsing, explicit destinations, cancellation, scoped progress, archive generation, or native file export.

The new feature crosses a real security boundary. `window.ts` disables Node integration and enables context isolation and sandboxing. The existing sender and session-owner checks should remain the entry point for every operation. The existing SSH transport and terminal session managers remain responsible for their current resources.

## Shape

Make the existing `SftpSessionManager` the owner of an SFTP file workspace. Each session contains its SFTP channel, resolved remote home, local-directory capabilities, job queue, active job, export leases, and owner. Keep renderer state limited to active tab, pane snapshots, selection, request revisions, context menu, and displayed job events. This follows **Model the Domain**: upload, download, archive creation, and drag staging are one job state machine instead of unrelated booleans and callbacks.

Use domain types in a dedicated `src/shared/sftp.ts`. Remove the old SFTP declarations from `database.ts` after migrating the callers. Keep the existing generic `TransferProgress` used by standalone file providers; the new SSH SFTP job event is independently scoped and does not force an unrelated provider refactor.

```ts
type LocalDirectory = { side: 'local'; rootId: string; relativePath: string };
type RemoteDirectory = { side: 'remote'; path: string };
type Directory = LocalDirectory | RemoteDirectory;
type EntryKind = 'file' | 'directory' | 'link' | 'other';
type LocalEntryRef = { side: 'local'; rootId: string; relativePath: string };
type RemoteEntryRef = { side: 'remote'; path: string };
type EntryRef = LocalEntryRef | RemoteEntryRef;

type FileEntry = {
  ref: EntryRef;
  name: string;
  kind: EntryKind;
  size: number | null;
  modifiedAt: number | null;
  directory: Directory | null;
};
type DirectoryPage = {
  location: Directory;
  displayPath: string;
  parent: Directory | null;
  entries: FileEntry[];
  truncated: boolean;
};
type PaneSnapshot =
  | { state: 'ready'; page: DirectoryPage }
  | { state: 'error'; attemptedPath: string; error: SftpOperationError };
type SftpWorkspace = {
  sftpId: string;
  sshSessionId: string;
  remoteHome: RemoteDirectory | null;
  local: PaneSnapshot;
  remote: PaneSnapshot;
};
type SftpOperationError = AppError & {
  operation: 'open' | 'resolve' | 'list' | 'stat' | 'write' | 'rename' | 'remove';
  path?: string;
  status?: number;
  reason: 'missing' | 'denied' | 'disconnected' | 'unsupported' | 'server-failure' | 'invalid' | 'unknown';
};
type FileDetails = {
  ref: EntryRef;
  kind: EntryKind;
  size: number | null;
  modifiedAt: number | null;
  accessedAt: number | null;
  permissions: number | null;
  uid: number | null;
  gid: number | null;
  linkTarget: string | null;
};

type FileChange =
  | { kind: 'mkdir'; directory: RemoteDirectory; name: string }
  | { kind: 'rename'; source: RemoteEntryRef; name: string }
  | { kind: 'delete'; source: RemoteEntryRef };
type FileWork =
  | { kind: 'upload'; sources: LocalEntryRef[]; destination: RemoteDirectory }
  | { kind: 'download'; sources: RemoteEntryRef[]; destination: LocalDirectory }
  | { kind: 'archive'; sources: RemoteEntryRef[]; destination: RemoteDirectory; name: string; format: 'tar' | 'tar.gz' | 'zip' }
  | { kind: 'prepare-native-drag'; sources: EntryRef[] };
type JobTicket = { jobId: string; sftpId: string };
type ExportLease = { id: string; names: string[]; expiresAt: number };
type JobEvent = { sftpId: string; jobId: string; sequence: number; label: string } & (
  | { state: 'queued' }
  | { state: 'running'; completedBytes: number; totalBytes: number | null; currentItem: string }
  | { state: 'completed'; refresh: Directory[]; exportLease?: ExportLease }
  | { state: 'cancelled'; partialPaths: string[] }
  | { state: 'failed'; error: AppError; partialPaths: string[] }
);

interface SftpApi {
  open(input: { sshSessionId: string }): Promise<Result<SftpWorkspace>>;
  list(input: { sftpId: string; directory: Directory }): Promise<Result<DirectoryPage>>;
  chooseLocalDirectory(input: { sftpId: string }): Promise<Result<DirectoryPage>>;
  details(input: { sftpId: string; entry: EntryRef }): Promise<Result<FileDetails>>;
  change(input: { sftpId: string; change: FileChange }): Promise<Result<{ refresh: RemoteDirectory[] }>>;
  enqueue(input: { sftpId: string; work: FileWork }): Promise<Result<JobTicket>>;
  uploadDropped(input: { sftpId: string; destination: RemoteDirectory }, files: File[]): Promise<Result<JobTicket>>;
  uploadFromPicker(input: { sftpId: string; destination: RemoteDirectory }): Promise<Result<JobTicket>>;
  cancel(input: { sftpId: string; jobId: string }): Promise<Result<void>>;
  startNativeDrag(input: { sftpId: string; leaseId: string }): void;
  onJob(listener: (event: JobEvent) => void): () => void;
}
```

`uploadDropped` is a renderer/preload API. Preload calls `webUtils.getPathForFile` for each actual `File`, then sends a separate strict wire request containing local paths. Main-process domain code sees validated local sources, never a DOM `File`. `startNativeDrag` uses an IPC event because it must be called directly from a user drag gesture. The handler validates the trusted sender, schema, session owner, lease owner, ready state, and expiry before calling `webContents.startDrag`. The renderer never selects the local file path handed to the OS.

The public surface hides recursion, conflict prompts, path policy, archive streams, job cancellation, and temporary file cleanup. Callers select a work item and consume events. Distinct input methods for dropped files and picker files converge on the same internal upload job; they do not create separate transfer implementations.

### Main-process ownership

```ts
type WorkspaceState = {
  ownerId: number;
  sshSessionId: string;
  remoteHome: string | null;
  localRoots: Map<string, { absolutePath: string }>;
  jobs: Map<string, OwnedJob>;
  pending: string[];
  activeJobId: string | null;
  exports: Map<string, OwnedExport>;
};

class SftpSessionManager {
  open(ownerId: number, sshSessionId: string): Promise<Result<SftpWorkspace>>;
  list(ownerId: number, sftpId: string, directory: Directory): Promise<Result<DirectoryPage>>;
  chooseLocalDirectory(ownerId: number, sftpId: string): Promise<Result<DirectoryPage>>;
  details(ownerId: number, sftpId: string, entry: EntryRef): Promise<Result<FileDetails>>;
  change(ownerId: number, sftpId: string, change: FileChange): Promise<Result<{ refresh: RemoteDirectory[] }>>;
  enqueue(ownerId: number, sftpId: string, work: FileWork): Result<JobTicket>;
  uploadDropped(ownerId: number, sftpId: string, destination: RemoteDirectory, localPaths: string[]): Result<JobTicket>;
  uploadFromPicker(ownerId: number, sftpId: string, destination: RemoteDirectory): Promise<Result<JobTicket>>;
  cancel(ownerId: number, sftpId: string, jobId: string): Result<void>;
  startNativeDrag(ownerId: number, sftpId: string, leaseId: string): Result<void>;
  closeForSsh(ownerId: number, sshSessionId: string): Promise<void>;
  closeOwner(ownerId: number): Promise<void>;
}

type InternalDroppedUpload = { kind: 'upload-local-paths'; localPaths: string[]; destination: RemoteDirectory };
type OwnedExport = { id: string; localPaths: string[]; stagingRoot: string | null; expiresAt: number; used: boolean };
type OwnedJob = {
  id: string;
  work: FileWork | InternalDroppedUpload;
  abort: AbortController;
  event: JobEvent;
};
```

Main owns one active mutating/transfer job per SFTP workspace and a bounded pending queue of 100 jobs. Separate SFTP workspaces own separate queues and temporary directories, per **Separate Before Serializing Shared State**. Browsing and stat remain responsive while a transfer runs. Rename/delete against active job sources or destinations return a busy error. Queued jobs revalidate paths when they start. Main emits the initial queued event only after the ticket can be returned, or retains a snapshot retrievable by job ID, so an early progress event cannot disappear before the renderer registers it. Events have monotonic sequence numbers; the renderer ignores older updates and keeps the latest 100 terminal records.

Cancellation destroys owned read/write streams, aborts the archiver, and settles exactly once. Channel close and SSH disconnect terminate all active/queued jobs with a session-scoped error. A deadline guards SFTP callbacks so a dropped channel cannot leave an IPC request pending forever. Close awaits bounded cleanup before ending the SFTP channel. The renderer's tab switch has no effect on jobs.

### Path and initial-directory rules

At SFTP open, resolve `realpath('.')` before constructing the initial remote page. List that absolute server result. A failed REALPATH produces a recoverable Files-pane error with its normalized status and an editable remote path field; the SSH terminal still works. Do not silently turn `.` into `/` or claim root access is the proven cause. Manual remote navigation accepts a bounded path, rejects NUL, and resolves it on the server before listing. Returned pages contain canonical paths, parent locations, directory locations for child entries, and an explicit 10,000-entry truncation flag. Server entry names are untrusted path input and must be rejected if they contain a slash, NUL, or are `.`/`..` before joining.

Local root capabilities start at the user's home directory and can be replaced using the native directory picker. A local location carries a root ID and relative path. Main resolves and checks containment against the canonical root on every filesystem boundary; renderer strings cannot grant another local root. Symlinks and Windows junctions are shown and inspectable but are not traversed by recursive copy or archive. Local browsing outside the selected root requires choosing another root. Drops from Explorer are a distinct explicit source grant validated by preload and main.

Before recursive downloads, validate each remote name against Windows filename rules and detect case-folded collisions. Report unsupported names rather than silently renaming or writing outside the chosen directory. Listing errors retain the failing operation, attempted path, and numeric SFTP status. Map permission denial, missing paths, lost connection, and unsupported operations to actionable text; optional server details are length-bounded and rendered as text.

### Transfer and archive semantics

Transfers support regular files and directories, recursively, with a 10,000-entry bound and no automatic symlink following. Enumerate with cancellation checks and bounded memory. Show the unknown total until enumeration can determine it. Confirm an existing destination in the main process with the exact paths. Do not treat a stale renderer boolean as overwrite authorization. Never retry writes automatically.

Write new downloads/uploads to operation-owned temporary names in the destination directory, then publish after successful stream completion. Use exclusive creation. Do not use an overwrite-capable rename extension for unconfirmed destinations. If the server cannot safely publish without replacement, return a conflict and retain the temporary path for the user instead of clobbering an existing file. Failure/cancellation reports any partial paths that could not be cleaned up. The implementation must not claim SFTP provides a transaction across a recursive directory transfer.

Use the MIT-licensed Archiver project dependency for TAR, gzip TAR, and ZIP. Enumerate selected remote sources with `lstat`, stream each regular file through Archiver, and stream output to an exclusively created remote temporary archive. Keep at most one input SFTP stream open. Preserve relative names, basic mode, and modification time. Refuse symlinks and special files with a clear item error. Exclude the output artifact from the source tree. A changed or unreadable source fails the job and records cleanup results; SFTP cannot promise a consistent filesystem snapshot while another process edits files.

For native drag preparation, materialize remote selections beneath a private, uniquely named application temp directory. Expose only an opaque ready lease after all files finish. Native drag references that local snapshot and never blocks on network I/O. Ready leases expire after 30 minutes of inactivity; refresh their expiry immediately before a native drag and do not delete their files while a native drag is running. Because Electron lacks a reliable cross-platform signal that every OS target finished reading the drag source, keep used staging directories until the next app launch, then clean only this application's marked stale staging directories. The lease controls new drags, not the lifetime of an OS consumer's already-started copy.

### Renderer shape

```text
SSH connection header
[ Terminal ] [ SFTP files ]
Terminal tab: preserved xterm panel
SFTP tab:
  Local path / Choose folder       Remote path / Home / Refresh
  Local entries                   Remote entries
  Upload selected ->              <- Download selected
  Session transfer jobs, cancel, partial-file result, ready native-drag handle
```

`SshWorkspace` owns connection state and the active tab. `SshTerminalPane` owns xterm setup/cleanup and an `active` prop that schedules fit/resize when revealed. `SftpWorkspace` owns pane state and request revisions; responses cannot replace a newer navigation or disconnected session. `FilePane` renders a supplied page and semantic events for selection, open, context menu, and drop. A single context-menu action registry supplies enabled states, labels, and handlers, so right-click and keyboard menus stay consistent. The existing palette and type scale remain; the path bars and paired transfer directions identify the two-pane workflow, per **Experience First**.

### Module map

| File | Responsibility |
| --- | --- |
| `src/shared/sftp.ts` | Domain requests/results, job states, directory and entry references. |
| `src/shared/sftp-validation.ts` | Strict IPC parsing and bounds, including the private dropped-path wire request. |
| `src/main/sftp/sftp-session-manager.ts` | Owner checks, file-workspace lifetime, queue and export-lease state, native dialogs. |
| `src/main/sftp/remote-files.ts` | SSH2 callback adaptation, canonical paths, status normalization, bounded listing/stat and remote streams. |
| `src/main/sftp/local-files.ts` | Local root capabilities, containment, Windows filename checks, local streams and staging cleanup. |
| `src/main/sftp/file-jobs.ts` | Recursive upload/download, archive streams, staging execution and cancellation. |
| `src/main/ipc/ssh-handlers.ts` | Trusted sender and schema checks, dispatch, native drag event. |
| `src/preload/index.ts` | Typed invocation, File-to-path drop adaptation, native drag event, scoped job subscription. |
| `src/renderer/workspaces/SshWorkspace.tsx` | Connection/header and two inner tabs. |
| `src/renderer/workspaces/ssh/SshTerminalPane.tsx` | Persistent terminal instance and refit on reveal. |
| `src/renderer/workspaces/sftp/SftpWorkspace.tsx` | Independent pane state, navigation revisions, selection and jobs. |
| `src/renderer/workspaces/sftp/FilePane.tsx` | Local/remote list rendering and user gestures. |
| `src/renderer/styles/sftp-workspace.css` | Tab, pane, context menu, progress and responsive rules. |

Only the manager is imported by the IPC layer. Its three internal helpers own distinct knowledge, and a main-process operation follows manager -> job executor -> local/remote boundary. Validators parse wire input once, per **Boundary Discipline**; internal job code consumes domain types.

The standalone `FilesWorkspace` remains on `FileSessionManager`. Share only the SFTP home-resolution/status helper, expose the provider's initial path in its descriptor, and use that instead of `/`. FTP, FTPS, and S3 keep their provider-specific starting-directory semantics. Do not merge their sessions or reuse SSH profile credentials through the standalone provider.

## Synthesis decision

This is candidate A. It recommends a session-owned job boundary because cancellation, progress routing, native export leases, and disconnect cleanup describe the same lifetime. The parent orchestrator owns the comparison and final synthesis.

## Tradeoffs accepted

- We accept one active transfer/archive per SFTP workspace in exchange for predictable channel load and cancellation.
- We accept a preparation step before remote native drag in exchange for an actual local drag source and visible progress for large files.
- We accept archive traffic passing through the client in exchange for compatibility with SFTP-only accounts and no remote package changes.
- We accept explicit local-directory roots in exchange for a renderer that cannot choose arbitrary local write destinations.
- We accept partial outcomes for recursive transfers in exchange for honest SFTP semantics; completed items are not silently rolled back or retried.

## Alternatives considered

**Extend every current SftpApi method and orchestrate jobs in the renderer.** This would keep the current class superficially smaller, but callers would own recursion, operation correlation, cancellation, overwrite prompts, and native-drag preparation. That is a shallow interface and leaks filesystem policy into UI lifecycle.

**General provider framework shared by SSH SFTP, standalone SFTP, FTP, and S3.** A unified file explorer is attractive long-term, but S3 prefixes, FTP archive capabilities, and SSH transport sharing have different semantics. This task can ship its specified SSH experience without coupling all providers to a new abstraction. Sharing the narrow home/error helper addresses the identical listing bug without that migration.

**Run remote tar/zip commands and install missing tools over SSH.** This hides compression work behind a command but exposes shell quoting, remote OS/package manager detection, privileges, command timeouts, and SFTP-only account failures. A local archive dependency provides the requested formats through the existing file protocol.

## Implementation reconciliation

No implementation changes were made for this candidate. If the chosen implementation uses raw local paths, changes native-drag preparation, or adopts a different queue owner, update the usage and ownership contract together before handing those interfaces to another worker.

## Open questions and risks

- What SFTP status does the user's server return? Preserve it in the error result; do not call the original failure reproduced until observed against that connection or a supplied diagnostic.
- Does the target Windows/Electron runtime preserve a native drag source through Explorer's copy operation as documented? Exercise local native drag and prepared remote native drag before claiming external drag complete.
- Does the server's standard rename operation preserve the required no-replacement behavior? Validate that capability or return a conflict/partial-file outcome where safe publication cannot be guaranteed.
- Does “tar, zip” also mean extraction? The selected default is creation only; extraction would need separate archive-path validation and destination policy.

## Verification of this design

The three caller examples map to declared methods and types. Job events carry both SFTP session identity and job identity. Browser operations cannot change terminal lifecycle. Local write destinations have a main-owned root. Native drag uses an existing local artifact and a new user drag gesture. Source grounding was read directly in the current SFTP manager, SSH handlers, SSH workspace, and file-provider contracts. This was design work only; no tests, app runs, or saved remote connections were used.

References: [Electron native file drag](https://www.electronjs.org/docs/latest/tutorial/native-file-drag-drop), [Electron webUtils](https://www.electronjs.org/docs/latest/api/web-utils), [Archiver streaming API](https://www.archiverjs.com/docs/archiver/), and [ssh2 SFTP API](https://github.com/mscdex/ssh2/blob/master/SFTP.md).

## Next implementation step

Introduce the dedicated SFTP domain contract and session-scoped job event, then change initial remote browsing to use the server's resolved working directory and normalized status errors.
