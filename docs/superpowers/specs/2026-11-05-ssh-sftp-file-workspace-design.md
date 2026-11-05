# SSH and SFTP file workspace design

## Problem

The SSH workspace opens SFTP at `/` and replaces every directory-list error with one generic message. Many SFTP accounts cannot list server root. The renderer has no local pane, path-to-path transfers, native file drag support, details view, or archive actions.

## User workflow

Open an SSH profile and select **Terminal** or **SFTP files** below the connection header. The Terminal tab keeps its xterm session mounted when hidden. The SFTP tab shows a local directory on the left and the remote directory on the right. Each pane has its own path, selection, and navigation state. Use single click to select, double click to open a directory, and drag items between panes to transfer them.

Drop files and folders from Explorer onto the remote pane to upload. Drag local pane entries outside Aetherexa to copy them to another Windows location. To drag remote entries outside the app, select **Prepare to drag** and wait for staging to finish. Then drag the ready item to Explorer or the desktop. Electron's native file drag API requires an existing local source file, so remote downloads cannot safely start inside the operating-system drag event.

Remote context actions include download, rename, details, create ZIP, TAR, or TAR.GZ, and delete. Empty-space actions include refresh and create folder. Archive extraction is not included.

## Data model

The renderer uses pane snapshots and opaque local roots. A local location is `{ rootId, relativePath }`; a remote location is `{ anchor, path }`, where `anchor` is either an absolute server path or the server's current directory. Entries identify a file, directory, symbolic link, or other item. Local and remote references remain distinct.

An SSH SFTP workspace owns its renderer owner, SSH session ID, SFTP channel, resolved remote start location, local browsing root, transfer jobs, and prepared native-drag leases. A job has a stable ID and request ID, operation kind, state, progress, owned streams, and any partial paths. Job events include the SFTP ID, job ID, and monotonically increasing sequence.

## Ownership and API boundary

`SftpSessionManager` remains the only public main-process owner of SSH SFTP operations. It owns one bounded queue per workspace, limits active file jobs across workspaces, and cancels jobs before closing their SFTP channel. It validates the owner and resolves location and entry references before each operation. Local file access, remote SFTP callbacks, archive streams, and drag leases stay inside the main process.

The renderer calls a typed preload API to open the workspace, list a pane, choose a local root, transfer selected entries, rename or remove a remote entry, read details, create an archive, cancel a job, and start a prepared native drag. Preload extracts dropped paths from actual `File` objects with `webUtils.getPathForFile`; it does not return local paths to renderer code. IPC validates strict request schemas and the trusted sender before calling the manager.

Transfers accept entry references from a current page. The manager snapshots validated sources and destination when it accepts a job. One job runs per workspace at a time, with at most two active file jobs in the app and no more than 100 pending per workspace. Listing remains available during a transfer. Jobs do not retry writes automatically. Failures and cancellation report any partial targets that remain.

## SFTP path and error behavior

On open, the manager calls `realpath('.')` and lists the returned directory. It returns the canonical displayed path with the first page. If the server reports that REALPATH is unsupported, the manager lists `.` and keeps a server-home-relative anchor. It never rewrites `.` to `/` silently. Permission, missing-path, disconnection, unsupported-operation, and other server status codes remain in the error result with the attempted path.

Listings stop at 10,000 entries and report truncation. Recursive jobs stop at depth 64 and 10,000 entries. They do not follow symbolic links. Before a remote path is used, the manager validates the path segments and resolves it through the server. Before a local write, it verifies that the destination stays under the selected local root. External drops are explicit user-provided upload sources and are checked as files or directories in the main process.

The standalone SFTP file-transfer provider uses the same home-resolution and normalized-error behavior, but keeps its own session and UI. FTP, FTPS, and S3 keep their existing provider semantics.

## Archive and drag behavior

The app uses the exact-pinned MIT `archiver` dependency for ZIP, TAR, and TAR.GZ creation. It reads remote files through SFTP streams and writes the archive through an exclusive remote temporary path before publishing it beside the selected item. No remote shell command or remote package installation is required. Unsupported links and special files produce a visible item error.

Remote OS drag-out creates a uniquely named directory under the app's temporary root. A ready lease contains only opaque IDs in the renderer. The manager checks owner and lease state before calling `webContents.startDrag`. The app retains used exports for at least 24 hours and removes only stale directories under its own temporary root on startup, because the OS may still be reading an export after the drag event ends.

## Alternatives considered

- Sending raw local and remote paths through many renderer-owned operations would expose path joining, overwrite, recursive traversal, and cleanup policy to UI code.
- Running `tar` or `zip` on the server would require shell access, remote utility detection, and possible remote package installation. A local archive dependency works with SFTP-only accounts and does not modify the server.
- Combining SSH SFTP with the standalone FTP/S3 workspace would mix different authentication and path models. This change shares only the narrow SFTP home-path behavior.

## Acceptance checks

- The SSH workspace switches between persistent Terminal and SFTP files tabs.
- The SFTP tab shows local-left and remote-right panes with independent navigation.
- A server-home-relative initial directory works when REALPATH is unsupported; an inaccessible path shows its mapped SFTP error.
- Internal pane transfers and Explorer drops upload or download files and directories with scoped progress, cancellation, and partial-target reporting.
- A prepared remote file or directory can be dragged out of the app through Electron's native drag API.
- Remote details, rename, delete, and ZIP/TAR/TAR.GZ actions remain owner-checked and use validated references.
- `npm run typecheck`, `npm run build`, and `git diff --check` pass. No automated tests or saved SSH profiles are used for verification.

