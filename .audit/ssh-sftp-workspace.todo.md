# SSH and SFTP workspace redesign

## Brainstorming

- [x] Explore project context and current SFTP flow
- [x] Confirm the requested user experience
- [x] Compare architecture approaches
- [x] Present the design and confirm it matches scope
- [x] Write and review the design specification
- [x] Create the implementation plan

## Architect phases

- [x] Ground the current session, IPC, and renderer flows
- [x] Sketch at least two distinct boundaries
- [x] Choose and record one coherent design
- [x] Implement after the design gate
- [x] Revisit the design if the implementation needs repeated workarounds

## Figure-it-out phases

- [x] Frame the falsifiable completion predicate and scope
- [x] Compare architecture candidates and select one
- [x] Build and verify the SFTP home-path and error slice
- [x] Add local browsing, pane transfers, and progress reporting
- [x] Add Terminal/SFTP tabs and two-pane UI
- [x] Add remote context actions, archive creation, and prepared drag-out
- [x] Verify typecheck/build and record remaining limits

## Design decisions

- Base: candidate A, one SFTP session-owned workspace and one bounded job queue per workspace.
- Graft from candidate B: `realpath('.')` fallback to a server-home-relative `.` anchor, and remove staged drag exports only after a 24-hour startup age check.
- Transfer event contract: preserve the existing progress event with a transfer ID; current operations report progress but do not expose queueing or cancellation.
- External drag: prepare the remote file or folder locally, then start the native drag from a ready lease. Local files can drag out immediately.
- Archive formats: ZIP, TAR, and TAR.GZ using the app's pinned `archiver` dependency; no remote package manager or shell.
- Directory enumeration: cap visible listings at 10,000 entries and recursive transfers/archives at depth 64 and 10,000 items; reject symlink traversal and Windows-invalid downloaded names.
- Scope: SSH workspace gets Terminal/SFTP tabs and local-left/remote-right panes. Standalone SFTP receives only its home-path and error fix; FTP, FTPS, and S3 keep their existing workspaces.
- Verification: typecheck and build only; no tests or live database/SSH profiles without explicit user authorization.

## Implementation status

- Implemented the approved user workflows in main-process SFTP operations and the SSH renderer.
- Transfers are sequential within each request but there is not yet a cancellable bounded job queue across concurrent requests.
- Local pane entries currently carry filesystem paths through the typed preload API; drag-out is restricted to paths returned by that owner's local listings.
- Prepared drag exports are retained for 24 hours and stale app-prefixed exports are removed on startup.
- Verified typecheck, build, and diff whitespace. No saved SSH profile was opened for verification; the currently visible packaged app is a different version and its existing connected session was left untouched.
