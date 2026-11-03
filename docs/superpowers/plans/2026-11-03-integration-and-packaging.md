# Integration and Windows Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` or `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate all workspaces into one navigable application and produce a Windows installable build with documented setup and recovery behavior.

**Architecture:** The shell routes profile selections to typed workspace descriptors. Packaging is reproducible from the locked dependency graph and includes required native modules, driver assets, and license notices.

**Tech Stack:** Electron, Vite, TypeScript, React, electron-builder or a maintained Windows packager chosen after package/runtime research.

## Global Constraints

- Keep the approved eight-engine scope and original visual design.
- Package for Windows x64 first; do not imply support for other operating systems.
- Keep the renderer isolated and keep secrets out of package metadata, logs, exports, and crash reports.
- Do not bundle redistributables or client libraries unless their licenses and redistribution terms are recorded.
- No automated tests are added or run unless the user asks for testing or verification.

---

### Task 1: Integrate navigation and workspace lifecycle

**Files:**
- Create: `src/renderer/workspaces/WorkspaceRouter.tsx`
- Create: `src/renderer/state/workspace-registry.ts`
- Modify: `src/renderer/components/AppShell.tsx`
- Modify: `src/renderer/components/ConnectionSidebar.tsx`
- Modify: `src/renderer/components/WorkspaceTabs.tsx`
- Modify: `src/shared/contracts.ts`

**Interfaces:**
- `WorkspaceDescriptor` has `id`, `kind`, `title`, `profileId`, `state`, and `closePolicy`.
- `WorkspaceRegistry.open(profileId, kind): WorkspaceDescriptor` deduplicates only when the caller explicitly requests focus-existing behavior.
- `WorkspaceRouter` maps each supported `kind` to one workspace component and renders a typed unsupported-workspace error for invalid kinds.

- [ ] Route each database, cache, terminal, and SFTP profile to its designated workspace.
- [ ] Preserve tab state when switching workspaces and release session resources only when a workspace is closed.
- [ ] Add connection-state badges and command search across all profile and host types.
- [ ] Apply keyboard shortcuts for opening, switching, and closing workspace tabs without capturing normal editor shortcuts.

### Task 2: Package the Windows application

**Files:**
- Create: `electron-builder.yml`
- Create: `docs/package-contents.md`
- Modify: `package.json`
- Modify: `docs/dependencies.md`
- Modify: `.gitignore`

**Interfaces:**
- `npm run package:win` creates a Windows x64 installer and unpacked application folder.
- `docs/package-contents.md` documents required runtime files and the files excluded from packages, including `.env`, local profiles, secret stores, and development-only files.

- [ ] Select the packager and exact native-module rebuild flow after checking Electron ABI compatibility for selected drivers and PTY support.
- [ ] Record dependency licenses and any required Oracle/SQL Server client prerequisites in `docs/dependencies.md` and the user guide.
- [ ] Exclude profile data, logs, local test fixtures, and development credentials from all package targets.
- [ ] Configure app identity, version, installer output path, and uninstall behavior without adding auto-update or network telemetry.

### Task 3: Write product and recovery documentation

**Files:**
- Create: `README.md`
- Create: `docs/user-guide.md`
- Create: `docs/security-and-credentials.md`
- Modify: `docs/dependencies.md`

**Interfaces:**
- The README describes supported Windows version/architecture, build commands, and current engine scope.
- The user guide describes profile setup, query/database/cache workspaces, terminal/SFTP tasks, and known engine limitations.

- [ ] Document first-run profile creation and how protected credentials can be reset without affecting remote data.
- [ ] Document SSH host-key review and changed-key handling.
- [ ] Document each connector's unsupported capabilities, including Memcached key enumeration limits.
- [ ] Document local data locations and the lack of cloud sync or relay.

