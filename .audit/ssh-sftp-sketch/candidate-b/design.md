# Candidate B: one file workspace per SSH session

## Usage from the caller's view

Open one file workspace on the authenticated SSH session. The response contains both initial pane states. The renderer displays **Terminal** and **SFTP files** tabs, keeps the terminal mounted, and renders local files on the left and remote files on the right.

```ts
const opened = await api.sftp.open({ sessionId: sshSession.sessionId });
if (opened.ok) {
  setFiles(opened.value);
  setLocal(opened.value.local);
  setRemote(opened.value.remote);
}

const next = await api.sftp.browse({
  workspaceId: files.workspaceId,
  side: 'remote',
  target: { kind: 'entry', entry: selectedDirectory.ref },
});
if (next.ok) applySnapshotIfCurrent(next.value);
```

The same transfer operation handles pane drags and upload/download buttons. Selection references and destination references come from a directory snapshot. The service returns a job before copying bytes; events always identify the workspace and job.

```ts
if (remote.kind !== 'ready') return;
const queued = await api.sftp.transfer({
  workspaceId: files.workspaceId,
  requestId: crypto.randomUUID(),
  sources: selectedLocalFiles.map((entry) => entry.ref),
  destination: remote.snapshot.directory,
});
if (queued.ok) rememberJob(queued.value);

api.sftp.onJobEvent((event) => {
  if (event.workspaceId === files.workspaceId) updateJob(event);
});
```

Remote context actions use the selected reference. A rename supplies a basename, rather than a second renderer-generated remote path. File details describe the link itself. Archive creation is a cancellable job, built in the app and saved beside the selected remote item.

```ts
await api.sftp.change({
  workspaceId: files.workspaceId,
  change: { kind: 'rename', entry: selected.ref, newName: 'logs-previous' },
});
const details = await api.sftp.inspect({ workspaceId: files.workspaceId, entry: selected.ref });
const archive = await api.sftp.archive({
  workspaceId: files.workspaceId,
  requestId: crypto.randomUUID(),
  entry: selected.ref,
  format: 'zip',
});
```

## Problem

The current SSH workspace opens SFTP and lists `/`, while the path validator changes `.` into `/`. Any `readdir` error loses its SFTP status and server message. The real server cause is unknown. The new file view also needs local filesystem access, explicit source/destination transfers, native OS dragging, details, archives, cancellation, and progress correlation. These operations share a connection and lifecycle, so one per-SSH file workspace should own their state. `SshSessionManager` continues to own credentials and the authenticated client; the standalone `FilesWorkspace` continues to use its separate providers.

## Shape

Use one main-process `SftpSessionManager` aggregate per SFTP workspace. It owns the SFTP channel, canonical local and remote directory locations, current snapshot references, queued jobs, active streams, and temporary drag exports. Its public API uses file-manager domain objects rather than `ssh2.Stats`, streams, Electron objects, or raw local paths. This follows Model the Domain and Foundational Thinking: the connection, directory references, and job state have one owner before the UI adds more interaction state.

```ts
type FileSide = 'local' | 'remote';
type EntryKind = 'file' | 'directory' | 'link' | 'other';
type WorkspaceId = string;
type EntryRef = string;
type DirectoryRef = string;
type JobId = string;
type DragLeaseId = string;

type FileEntry = {
  ref: EntryRef;
  name: string;
  kind: EntryKind;
  size: number | null;
  modifiedAt: number | null;
};
type DirectorySnapshot = {
  side: FileSide;
  directory: DirectoryRef;
  revision: number;
  displayPath: string;
  entries: FileEntry[];
  hasParent: boolean;
  truncated: boolean;
};
type FileWorkspace = {
  workspaceId: WorkspaceId;
  sshSessionId: string;
  local: InitialPane;
  remote: InitialPane;
};
type InitialPane =
  | { kind: 'ready'; snapshot: DirectorySnapshot }
  | { kind: 'unavailable'; attemptedPath: string; failure: FileFailure };
type NavigationTarget =
  | { kind: 'home' }
  | { kind: 'parent' }
  | { kind: 'refresh' }
  | { kind: 'entry'; entry: EntryRef }
  | { kind: 'path'; path: string };
type FileChange =
  | { kind: 'mkdir'; directory: DirectoryRef; name: string }
  | { kind: 'rename'; entry: EntryRef; newName: string }
  | { kind: 'remove'; entries: EntryRef[] };
type FileDetails = {
  name: string;
  side: FileSide;
  displayPath: string;
  kind: EntryKind;
  size: number | null;
  modifiedAt: number | null;
  accessedAt: number | null;
  mode: number | null;
  uid: number | null;
  gid: number | null;
  linkTarget: string | null;
};
type FileFailure = {
  code: 'not-found' | 'permission-denied' | 'connection-lost' | 'unsupported'
    | 'stale-selection' | 'conflict' | 'cancelled' | 'operation-failed';
  message: string;
  retryable: boolean;
  operation: string;
  displayPath?: string;
  sftpStatus?: number;
};
type FileResult<T> = { ok: true; value: T } | { ok: false; error: FileFailure };
type JobReceipt = { workspaceId: WorkspaceId; jobId: JobId };
type JobState =
  | { kind: 'queued' }
  | { kind: 'running'; completedBytes: number; totalBytes: number | null; currentName: string }
  | { kind: 'completed'; completedBytes: number }
  | { kind: 'cancelled'; partialTargets: string[] }
  | { kind: 'failed'; failure: FileFailure; partialTargets: string[] };
type FileJobEvent = JobReceipt & {
  sequence: number;
  operation: 'upload' | 'download' | 'archive' | 'prepare-drag';
  label: string;
  state: JobState;
};
type DragExport =
  | { kind: 'preparing'; job: JobReceipt }
  | { kind: 'ready'; leaseId: DragLeaseId; label: string; expiresAt: number };

interface SftpApi {
  open(input: { sessionId: string }): Promise<FileResult<FileWorkspace>>;
  browse(input: { workspaceId: WorkspaceId; side: FileSide; target: NavigationTarget }): Promise<FileResult<DirectorySnapshot>>;
  chooseLocalDirectory(input: { workspaceId: WorkspaceId }): Promise<FileResult<DirectorySnapshot>>;
  inspect(input: { workspaceId: WorkspaceId; entry: EntryRef }): Promise<FileResult<FileDetails>>;
  change(input: { workspaceId: WorkspaceId; change: FileChange }): Promise<FileResult<void>>;
  transfer(input: TransferCommand): Promise<FileResult<JobReceipt>>;
  uploadDropped(input: { workspaceId: WorkspaceId; files: File[]; destination: DirectoryRef }): Promise<FileResult<JobReceipt>>;
  archive(input: { workspaceId: WorkspaceId; requestId: string; entry: EntryRef; format: 'zip' | 'tar' | 'tar.gz' }): Promise<FileResult<JobReceipt>>;
  prepareDrag(input: { workspaceId: WorkspaceId; entries: EntryRef[] }): Promise<FileResult<DragExport>>;
  startDrag(input: { workspaceId: WorkspaceId; leaseId: DragLeaseId }): void;
  cancelJob(input: JobReceipt): Promise<FileResult<void>>;
  onJobEvent(listener: (event: FileJobEvent) => void): () => void;
}
type TransferCommand = {
  workspaceId: WorkspaceId;
  requestId: string;
  sources: EntryRef[];
  destination: DirectoryRef;
};
```

`uploadDropped` is a preload convenience, not a raw IPC schema. It receives real browser `File` objects, uses `webUtils.getPathForFile`, rejects empty paths, and sends the resulting source paths directly to the validated main handler without returning paths to renderer code. All other local transfer sources use entry references from a main-process listing. The IPC layer parses strict request unions and passes the window owner ID. Domain methods accept owned workspace references, revalidate the current item with `lstat`, and bind all generated child names to their parent directory. Basenames reject separators, NUL, `.` and `..`. No shell command is constructed.

The aggregate stores this private state:

```ts
type OwnedFileWorkspace = {
  ownerId: number;
  sshSessionId: string;
  remote: SftpRemoteFs;
  panes: Map<FileSide, {
    location: ResolvedLocation;
    latestRequestedRevision: number;
    snapshot: DirectorySnapshot | null;
    entries: Map<EntryRef, ResolvedEntry>;
  }>;
  jobs: Map<JobId, FileJob>;
  acceptedRequests: Map<string, JobId>;
  pendingJobs: JobId[];
  activeJob: JobId | null;
  dragExports: Map<DragLeaseId, OwnedDragExport>;
};
type LocalLocation = { side: 'local'; absolutePath: string };
type RemoteLocation = { side: 'remote'; anchor: 'absolute' | 'server-home'; path: string };
type ResolvedLocation = LocalLocation | RemoteLocation;
type ResolvedEntry = {
  name: string;
  location: ResolvedLocation;
  kind: EntryKind;
  expected: { size: number | null; modifiedAt: number | null };
};
type OwnedStream = { destroy(error?: Error): void };
type FileJob = {
  receipt: JobReceipt;
  operation: FileJobEvent['operation'];
  sources: ResolvedEntry[];
  destination: ResolvedLocation | null;
  state: JobState;
  controller: AbortController;
  streams: Set<OwnedStream>;
};
type OwnedDragExport = {
  ownerId: number;
  workspaceId: WorkspaceId;
  tempDirectory: string;
  localPaths: string[];
  expiresAt: number;
  lastDragAt: number | null;
};
interface SftpRemoteFs {
  initialLocation(): Promise<RemoteLocation>;
  list(location: RemoteLocation, limit: number): Promise<{ entries: ResolvedEntry[]; truncated: boolean }>;
  details(entry: ResolvedEntry): Promise<FileDetails>;
}

class SftpSessionManager {
  private readonly workspaces = new Map<WorkspaceId, OwnedFileWorkspace>();
  private runningJobs = 0;
  open(owner: number, sshSessionId: string): Promise<FileResult<FileWorkspace>> {
    throw new Error('not implemented');
    // Open the owned SFTP channel, resolve realpath('.'), list it, and return both initial pane states.
  }
  transfer(owner: number, input: TransferCommand): Promise<FileResult<JobReceipt>> {
    throw new Error('not implemented');
    // Resolve current references, deduplicate requestId, enqueue immutable sources/destination, and return before bytes flow.
  }
  closeForSsh(owner: number, sshSessionId: string): Promise<void> {
    throw new Error('not implemented');
    // Cancel queued/active jobs, destroy streams, release exports, then close SFTP.
  }
}
```

Each pane has its own revision counter and entry map. An initial listing failure produces an unavailable pane with Retry, Go home, and Go to path controls; it does not close the SFTP channel or block the other pane. An older listing cannot replace a newer committed snapshot. A context menu opened on an obsolete snapshot receives `stale-selection` and asks for refresh. A job resolves references into immutable absolute or server-home-anchored paths when accepted, then checks live metadata before opening sources. Jobs are sequential per workspace, with a global cap of two active file jobs across workspaces. The service deduplicates a retried request ID within that workspace and never automatically retries a mutation with an unknown outcome.

Transfers support regular files and directory trees in both directions. Traversal uses `lstat`, rejects link traversal, limits depth to 64 and entries to 10,000, and refuses malformed remote filenames. A rejected link produces a useful result rather than silently omitting data. Files write to app-owned partial names and publish the final name only after streaming completes. Delete and overwrite prompts occur in the main process. If a remote server cannot replace a staged target safely, the operation asks for a new destination name rather than deleting the existing file before upload succeeds. Cancellation destroys all job-owned streams; only app-owned partial targets may be removed automatically, and cleanup failures remain visible in `partialTargets`.

The API is deeper than the current path-based methods: the renderer chooses a selection and destination, while the aggregate owns recursive traversal, canonical paths, overwrite decisions, progress correlation, cancellation, staging, and cleanup. Separate task-shaped methods keep the interface discoverable. A generic `execute` command would save method names but force every caller to understand a response union.

## Directory opening and errors

`SftpRemoteFs.initialLocation()` resolves `realpath('.')` before browsing. It does not run the current helper that adds `/` to every relative path. A directory navigation resolves the requested location using the server, then calls `readdir` on that location. The snapshot returns the resolved path and a truncation flag, so UI labels match the listed directory. Use `opendir` and bounded handle-based `readdir` calls to stop after 10,001 entries instead of materializing an unlimited listing. If `REALPATH` is unsupported, attempt a bounded `readdir('.')` and retain a location anchored to the server home. Disable parent navigation above that unknown home until an absolute path can be resolved. Do not silently substitute `/`.

SFTP errors map status 2 to not found, 3 to permission denied, 6/7 or channel close to connection lost, and 8 to unsupported. Other statuses retain their numeric code and a clipped server message with control characters removed. The UI can show, for example, “Permission denied while listing /restricted” instead of the current generic message. Every operation has a deadline and channel-close listener, because an abandoned callback must not leave a pane busy forever. Exact server diagnosis remains a runtime evidence task.

The standalone SFTP provider receives the same home-path/error fix through the small internal `SftpRemoteFs` helper. `FileProviderSession` gains `initialPath`; `FileSessionDescriptor` returns it, and `FilesWorkspace.connect()` uses it. FTP and S3 provide their existing initial `/` value. This shares SFTP protocol knowledge without combining authentication or UI models.

## Native drag and archive behavior

Pane-to-pane drags immediately enqueue uploads or downloads. OS file drops call the preload bridge and join the same upload queue. Local entries can start native OS dragging immediately. Remote entries must be fully materialized locally before Electron can hand files to Explorer or another app. `prepareDrag` creates a managed export job; its completed transfer row becomes a ready-to-drag item. Its `ondragstart` calls the fire-and-forget `startDrag` bridge, which synchronously invokes `webContents.startDrag` on an owned ready lease. This gives a reliable native drag contract without depending on a network download completing during the OS drag-start event. A prototype may prove that preparation can begin on pointer-down and complete during the first gesture; that can improve the first-drag experience without changing the lease API.

Remote exports live in a unique app-owned temporary directory. Leases are bound to owner/workspace and expire after 30 minutes. Disconnect invalidates the token immediately but retains exported files until at least 30 minutes after the last native drag, because the OS may still be reading them. Shutdown leaves these exports for later cleanup rather than risking an external copy. Startup cleanup removes only app-owned export directories older than 24 hours. External drag supports regular files and directory trees, subject to the same traversal limits as downloads.

Right-click remote menus contain Download to local pane, Rename, File details, Create ZIP, Create TAR, Create TAR.GZ, Copy path, and Delete. Empty-space menus contain New folder, Refresh, and Go home. Details use `lstat` and optional `readlink`; rename and delete operate on the selected link itself. Archive creation is the defined meaning of tar/zip for this change.

Add the exact-pinned MIT `archiver` project dependency and its matching type declarations if required by the installed version. The archive job first builds a validated manifest, then streams remote reads through Archiver into a new remote partial file beside the source. It creates the archive beside the selected item, so it cannot include its own output. Cancellation aborts Archiver and every source/output stream. No remote package manager, privilege escalation, or shell command is needed. This accepts download-plus-upload bandwidth in exchange for consistent archive behavior on SFTP-only servers.

## Module map

| File | Responsibility |
| --- | --- |
| `src/shared/sftp.ts` | Domain DTOs, API, directory references, job event/state unions |
| `src/shared/sftp-validation.ts` | Strict IPC request schemas and bounds |
| `src/main/sftp/sftp-session-manager.ts` | Owned workspace aggregate, snapshots, jobs, mutations, transfer orchestration |
| `src/main/sftp/sftp-remote-fs.ts` | SFTP canonical paths, status mapping, lstat/read/list/stream operations, callback deadlines |
| `src/main/sftp/local-file-access.ts` | Local canonical paths, directory snapshots, native picker, read/write streams |
| `src/main/sftp/file-job.ts` | One job's stream ownership, cancellation and partial-target result; internal to manager |
| `src/main/sftp/drag-exports.ts` | Managed temporary exports, ready leases, native drag and expiry cleanup |
| `src/main/ipc/ssh-handlers.ts` | Trusted sender, schema parsing, owner-aware dispatch and native drag event |
| `src/preload/index.ts` | Typed invokes, File-to-path conversion, native drag send, event subscription |
| `src/renderer/workspaces/SshWorkspace.tsx` | SSH connection and Terminal/SFTP tab selection |
| `src/renderer/workspaces/terminal/SshTerminalPane.tsx` | Existing xterm instance, channel subscriptions and refit when visible |
| `src/renderer/workspaces/sftp/SftpWorkspace.tsx` | Two pane snapshots, selection, listing revisions, context actions and jobs |
| `src/renderer/workspaces/sftp/FilePane.tsx` | File table, path controls, selection, double-click and DnD gestures |
| `src/renderer/workspaces/sftp/FileContextMenu.tsx` | Keyboard-accessible context menu and action labels |
| `src/renderer/workspaces/sftp/FileDetailsDialog.tsx` | Serialized metadata display |
| `src/renderer/workspaces/sftp/TransferList.tsx` | Session-filtered job state, progress, cancel, partial-file state and ready drag exports |
| `src/renderer/styles/sftp-workspace.css` | Top tabs and balanced local/remote panes, focus and drop targets |
| `src/main/files/{provider-contracts,file-session-manager,sftp-provider}.ts` | Narrow standalone SFTP initialPath/error compatibility change |
| `src/renderer/workspaces/FilesWorkspace.tsx` | Use returned provider initialPath |

The core runtime path is renderer → validated IPC → `SftpSessionManager`, with local/SFTP/drag details private behind that owner. UI components receive data and action callbacks; they do not coordinate filesystem calls.

## Synthesis decision

This candidate chooses one per-SSH file workspace aggregate with owned directory references and job state. It concentrates the invariants shared by listing, selection, transfer, archive, and native export. The candidate's distinctive contribution is the ready drag lease, which represents Electron's need for a real local file without leaking temporary paths to the renderer. The arena owner should compare this aggregate against a smaller extension of the existing path-based API before choosing it as the base.

## Tradeoffs accepted

- We accept more main-process workspace state in exchange for one owner of directory references, job lifecycle, temporary files, and overwrite policy.
- We accept a preparation step for first-time remote OS dragging in exchange for starting native drag only with an existing local source.
- We accept local CPU and two-way network traffic for archive creation in exchange for supporting servers with SFTP access but no shell or archive packages.
- We accept refusing symlink traversal in exchange for bounded recursive transfers with no cycles or accidental copies outside the selected tree.
- We accept local browse permissions matching the desktop process in exchange for a useful file-manager pane; native selection and owned entry references constrain transfer inputs.

## Alternatives considered

1. Extend the current `SftpApi` with raw local paths, raw remote paths, one method per operation, and renderer-owned transfer sequencing. This is a smaller patch initially, but every drag, menu, and transfer caller must learn path joining, local grants, overwrite stages, and progress IDs. It exposes the service's policy instead of hiding it.
2. Use remote `tar`/`zip` shell commands and install missing packages on the remote host. It hides archive bytes behind a command but exposes shell availability, quoting, platform detection, privilege, package managers, and partial command outcomes. The user's project-package installation request does not require those remote system changes.
3. Introduce a generic VFS for local, SFTP, FTP, S3, and the standalone Files workspace. This could unify future UIs, but it broadens the task into a provider migration and would force object-store semantics into filesystem navigation. The current request can be completed with the existing SSH ownership boundary.

## Implementation reconciliation

No application code has changed in this candidate. The initial-path/error correction can land first without waiting for the new UI. Every later unit must preserve the contract that entry references are workspace-owned, job events are correlated, and native drag sources are ready local files. A prototype that changes the timing of remote drag preparation should retain the same lease ownership and cleanup rules.

## Open questions and risks

- Which status and server message accompany the original failing directory request? The first runtime check should capture this normalized information and the resolved home path.
- Does a direct first-gesture remote drag remain active after asynchronous staging on the supported Electron/Windows build? Prototype it before promising that interaction; the ready lease contract supplies a reliable fallback.
- Can the target SFTP server perform a safe replacement rename? Detect support and report a rename conflict when it cannot, rather than promising atomic replacement everywhere.

## Next implementation step

Define the directory/job DTOs and add server-home resolution with normalized SFTP errors, then compile before connecting the new file workspace UI.
