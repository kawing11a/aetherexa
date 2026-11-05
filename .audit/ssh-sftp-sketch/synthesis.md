# SSH/SFTP workspace design synthesis

## Selection

Candidate A is the base: keep each SFTP channel and its file workspace inside `SftpSessionManager`, with strict owner-checked IPC and a local/remote two-pane renderer. The cross-review scored A 28, B 27, and C 25. Candidate B contributed the `realpath('.')` home-path fallback and 24-hour drag-export retention. Candidate C did not add a feature that changed the selected design.

## Implemented

- Resolve the SFTP start path with `REALPATH('.')`, retain `.` when the operation is unsupported, and preserve path-aware list errors with mapped status.
- Show independent Terminal and SFTP files tabs; keep xterm mounted while the SFTP view is visible.
- Browse local files on the left and remote files on the right, with recursive pane/Explorer transfers and progress events.
- Add remote rename, details, delete, and ZIP/TAR/TAR.GZ actions. Build archives from SFTP streams with the app-pinned `archiver` dependency.
- Add prepared remote drag-out, local drag-out, safe recursive staging, and stale app-owned export cleanup.
- Reject symlink traversal and cap recursive operations by depth and entry count.

## Deliberate follow-up limits

- A bounded cancellable cross-request job queue, atomic temporary sibling writes for regular transfers, and explicit partial-target records remain unimplemented.
- The local pane passes absolute path references through typed preload calls; local drag-out is restricted to entries listed for that renderer owner.
- Live SFTP status mapping and OS drag behavior were not verified against a disposable server. The existing packaged Aetherexa window had a live session and was left untouched. The worktree's dev launch failed because the Electron runtime reports `Electron uninstall`.
