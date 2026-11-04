# Aetherexa Rebrand and Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax.

**Goal:** Rename the Windows desktop app to Aetherexa, publish the MIT-licensed source and installers at `kawing11a/aetherexa`, and enable in-place updates for Squirrel Setup.exe installations.

**Architecture:** Keep Electron Forge and its Squirrel.Windows, WiX, and ZIP makers. Use Electron's native `autoUpdater` with the public `update.electronjs.org` feed; expose updater status and user actions through validated main-process IPC. Migrate the old app-data directory once, without replacing any existing Aetherexa data.

**Tech Stack:** Electron 45, Electron Forge 8, TypeScript, React, Electron `autoUpdater`, GitHub Actions, WiX Toolset 3.14.1.

## Global Constraints

- Windows x64 is the supported release platform.
- The source repository is public `kawing11a/aetherexa`; use MIT licensing.
- Keep producing Squirrel Setup.exe, WiX MSI, and portable ZIP on each successful package build.
- Attach `RELEASES` and the full `.nupkg` as well as installers to each GitHub Release so Squirrel updates work.
- Automatic in-place updates apply to Squirrel Setup.exe installations; MSI remains for managed Windows Installer upgrades.
- Keep the renderer sandboxed; all updater operations remain in the main process behind trusted-sender-checked IPC.
- Do not check for updates in development; preserve user data and honor `UNIFIED_PRODUCTIVITY_DATA_DIR`.
- Do not add or run automated tests. Run `npm run typecheck`, `npm run build`, and `npm run package` to verify the requested release artifacts.

---

### Task 1: Rename the application and wire the supplied icon

**Files:**
- Create: `src/renderer/assets/aetherexa.png` (the supplied source icon)
- Create: `assets/aetherexa.ico` (multi-size Windows icon derived from the supplied PNG)
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `forge.config.cjs`
- Modify: `scripts/package-windows.cjs`
- Modify: `src/main/index.ts`
- Modify: `src/main/window.ts`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/components/AppShell.tsx`
- Modify: `src/renderer/styles/app-shell.css`
- Modify: `src/main/connectors/sqlserver/sqlserver-adapter.ts`

**Interfaces:**
- Package identity: product name `Aetherexa`; repository `https://github.com/kawing11a/aetherexa`; license `MIT`.
- Squirrel shortcut identity and Windows app-user-model ID use the same Aetherexa Squirrel package identity.
- The existing WiX `upgradeCode` remains `072df083-5b0f-4d3d-99aa-874edf1be779`.

- [x] Copy the provided 110×110 PNG into `src/renderer/assets/aetherexa.png`; create `assets/aetherexa.ico` with 16, 24, 32, 48, 64, 128, and 256 pixel entries, preserving transparency and the source artwork.
- [x] Update package name/productName/author/repository/license and refresh the lockfile with `npm install --package-lock-only`.
- [x] Set Forge's app icon, Squirrel setup icon and Aetherexa author/description, and WiX icon, manufacturer, executable, and app-user-model ID. Keep the existing WiX upgrade code.
- [x] Rename the BrowserWindow title, HTML title, renderer brand, settings label, and account initials to Aetherexa.
- [x] Use the PNG in the renderer header and set the ICO on Forge's build configuration; exclude the source assets from the packaged app payload.

### Task 2: Preserve existing local data on first Aetherexa launch

**Files:**
- Create: `src/main/storage/app-data-migration.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- `prepareAppDataDirectory(): void` runs before any profile, secret, SSH, or cache store is constructed.
- Explicit `UNIFIED_PRODUCTIVITY_DATA_DIR` is used unchanged and bypasses the legacy-directory migration.

- [x] Resolve the new directory as `%APPDATA%\\Aetherexa` and the legacy directory as `%APPDATA%\\Unified Productivity` using Electron's `app.getPath('appData')`.
- [x] If an explicit data directory exists in the environment, create it and set Electron's `userData` path to it without inspecting or moving either default directory.
- [x] Otherwise, if only the legacy directory exists, rename it to the Aetherexa directory before setting `userData`; if both exist, retain both and use the Aetherexa directory without overwriting either.
- [x] If the legacy rename fails, keep using the legacy directory and surface a safe startup log so existing profiles and encrypted secrets remain accessible.
- [x] Call the migration before constructing `ProfileStore`, `SecretStore`, and `KnownHostsStore`.

### Task 3: Implement the packaged Windows update manager

**Files:**
- Create: `src/main/update/update-manager.ts`
- Create: `src/main/ipc/update-handlers.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/ipc/register-handlers.ts`
- Modify: `src/shared/contracts.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- `UpdateStatus` is `{ state: 'unsupported' | 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'error'; message: string }`.
- `UpdateManager.getStatus(): UpdateStatus` returns the latest status.
- `UpdateManager.checkNow(): void` invokes Electron `autoUpdater.checkForUpdates()` once when a check is not already running.
- `UpdateManager.install(): void` calls `autoUpdater.quitAndInstall()` only in the `ready` state.
- `ProductivityApi.app` exposes `getUpdateStatus()`, `checkForUpdates()`, `installUpdate()`, and `onUpdateStatus(listener)`.

- [x] Set the feed to `https://update.electronjs.org/kawing11a/aetherexa/win32-x64/${app.getVersion()}` using Electron `autoUpdater.setFeedURL()`.
- [x] Initialize updates only in packaged Windows builds; leave development and MSI-installed builds in the `unsupported` state.
- [x] Skip automatic checks for Squirrel setup/update/uninstall event launches, and wait 15 seconds before the first normal launch check to clear Squirrel's first-run file lock.
- [x] Check hourly after startup and allow the Settings view to request an immediate check; do not overlap checks.
- [x] Map `checking-for-update`, `update-available`, `update-not-available`, `update-downloaded`, and `error` events to the shared `UpdateStatus`; do not include raw network errors in renderer messages.
- [x] Send state changes to the current trusted window and return current status when a window opens after an event.
- [x] Validate every update IPC sender with `assertTrustedSender`; do not expose `autoUpdater` or raw IPC to the renderer.

### Task 4: Replace the installer-link dialog with an update status view

**Files:**
- Modify: `src/renderer/components/UpdateDialog.tsx`
- Modify: `src/renderer/components/AppShell.tsx`
- Modify: `src/shared/contracts.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/styles/app-shell.css`

**Interfaces:**
- `UpdateDialog` receives `currentVersion: string`, `status: UpdateStatus`, `onCheck(): void`, `onInstall(): void`, and `onClose(): void`.
- The renderer uses only the typed `ProductivityApi.app` methods from Task 3.

- [x] Remove the editable GitHub repository field, GitHub REST release fetch, external installer links, and `localStorage` repository setting.
- [x] Show the installed version and state-specific text for checking, current, downloading, ready-to-restart, error, and unsupported MSI/development builds.
- [x] Show **Check for updates** only when the updater is supported and not already checking/downloading.
- [x] Show **Restart now to update** only when the updater reports `ready`; let **Later** close the view without cancelling the downloaded update.
- [x] Subscribe to update status on app startup and unsubscribe when `AppShell` unmounts; open Settings from the existing navigation control.

### Task 5: Add the open-source project README and MIT license

**Files:**
- Modify: `README.md`
- Create: `LICENSE`
- Modify: `docs/package-contents.md`
- Modify: `docs/dependencies.md`
- Modify: `scripts/package-windows.cjs`

- [x] Replace Unified Productivity branding with Aetherexa and describe the existing eight database/cache engines, SSH authentication methods, terminal, and SFTP capabilities.
- [x] Document Windows x64 requirements, install choices, `npm ci`, typecheck/build/package commands, WiX 3.14.1 setup, local data migration, credential handling, and project limitations.
- [x] Explain that Setup.exe installations update in the background and apply updates on restart; MSI is for managed deployment and is upgraded by installing a newer MSI.
- [x] Include the GitHub project URL, contribution/issue location, and MIT copyright `Copyright (c) 2026 kawing11a`.
- [x] Replace prior manual release-checker documentation and remove claims that the app has no updater.

### Task 6: Publish all required assets for each tag release

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `docs/package-contents.md`
- Modify: `README.md`

- [x] Keep the workflow on pushed `v*` tags, set package version from the semantic-version tag, and use `kawing11a/aetherexa` as the packaged repository.
- [x] Build MSI, Squirrel Setup.exe, portable ZIP, and the Squirrel `RELEASES`/full `.nupkg` support assets on `windows-latest`.
- [x] Configure the release action globs to attach `*.exe`, `*.msi`, `*.zip`, `RELEASES`, and `*-full.nupkg` from their Forge output directories.
- [x] Keep `contents: write` as the only workflow permission and use the workflow token for release creation.
- [x] Document how a pushed semver tag produces the release and list every published asset.

### Task 7: Build, commit, and publish the first release

**Files:**
- Verify: `release/make/squirrel.windows/x64/`
- Verify: `release/make/wix/x64/`
- Verify: `release/make/zip/win32/x64/`
- Verify: `.github/workflows/release.yml`

- [x] Run `npm run typecheck` and `npm run build`.
- [x] Run `npm run package` and confirm Setup.exe, MSI, ZIP, `RELEASES`, and `*-full.nupkg` exist.
- [x] Confirm the package excludes source PNG and local profile, secret, and host-key data.
- [x] Commit all intended Aetherexa changes as `feat: rebrand desktop app as Aetherexa`.
- [x] Add `https://github.com/kawing11a/aetherexa.git` as `origin` if it is not already configured; push the committed source to the repository's `main` branch.
- [x] Push tag `v0.1.0` at the verified source commit to trigger the release workflow.
- [x] Wait for the GitHub Actions run and confirm the public `v0.1.0` release contains the MSI, Setup.exe, ZIP, `RELEASES`, and full `.nupkg` assets.

## Handoff

The user's earlier choice was inline execution in this session. After writing and self-reviewing this plan, execute it in this worktree with review checkpoints, then commit, push, and verify the first GitHub Release as requested.
