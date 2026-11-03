# Shell and Profile Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` or `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the hardened Windows desktop shell, typed boundaries, grouped profiles, and protected local credential storage that later workspaces share.

**Architecture:** The Electron main process owns local storage and privileged operations. A sandboxed React renderer uses a narrow preload API and typed IPC contracts. Profile records contain non-secret metadata; credentials are encrypted separately through Electron's asynchronous `safeStorage` API.

**Tech Stack:** Electron, electron-vite, TypeScript, React, Vite, Zod for input validation, and Electron `safeStorage` asynchronous methods.

## Global Constraints

- Windows is the first supported desktop platform.
- Keep `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, and a restrictive Content Security Policy.
- Validate the sender and shape of every IPC request.
- Credentials remain local and are never included in logs or exports.
- Use `safeStorage.isAsyncEncryptionAvailable`, `encryptStringAsync`, and `decryptStringAsync`; the synchronous methods are deprecated. See [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).
- No automated tests are added or run unless the user asks for testing or verification.

---

### Task 1: Scaffold the Electron/Vite TypeScript application

**Files:**
- Create: `package.json`
- Create: `electron.vite.config.ts`
- Create: `tsconfig.json`
- Create: `src/main/index.ts`
- Create: `src/preload/index.ts`
- Create: `src/renderer/index.html`
- Create: `src/renderer/main.tsx`
- Create: `src/renderer/App.tsx`

**Interfaces:**
- `src/main/index.ts` starts Electron and delegates window construction to `createMainWindow()`.
- `src/renderer/App.tsx` is the renderer root and initially renders `AppShell`.

- [ ] Create the package manifest with scripts `dev`, `build`, `package`, and `typecheck`; do not add test scripts.
- [ ] Configure separate main, preload, and renderer TypeScript build entries in `electron.vite.config.ts`.
- [ ] Set strict TypeScript options and explicit aliases for `@shared`, `@main`, and `@renderer`.
- [ ] Add the minimal main, preload, and React entry files with typed imports and no direct privileged calls from the renderer.
- [ ] Record selected package versions and licenses in `docs/dependencies.md` before installing protocol dependencies.

### Task 2: Lock down the window and IPC boundary

**Files:**
- Create: `src/main/window.ts`
- Create: `src/main/ipc/register-handlers.ts`
- Create: `src/preload/index.ts`
- Create: `src/shared/contracts.ts`
- Create: `src/shared/validation.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- `createMainWindow(): BrowserWindow` creates a local-only window with `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, and the bundled preload.
- `registerHandlers(window: BrowserWindow): void` registers only typed, validated commands and rejects requests from unexpected web contents.
- `window.productivityApi` exposes named functions; it does not expose `ipcRenderer`, arbitrary channels, filesystem APIs, or Node objects.

- [ ] Define shared result shapes `Result<T> = { ok: true; value: T } | { ok: false; error: AppError }` and `AppError = { code: string; message: string; retryable: boolean }`.
- [ ] Define Zod schemas for all IPC request payloads before registering the first handler.
- [ ] Configure a restrictive local-content CSP and deny unexpected navigation and new-window creation.
- [ ] Keep Electron security defaults enabled and validate each IPC sender. Follow the [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security).
- [ ] Add one harmless `app:get-version` request/response through the full preload boundary to establish the IPC pattern.

### Task 3: Add grouped profile storage and protected secrets

**Files:**
- Create: `src/shared/profiles.ts`
- Create: `src/main/storage/profile-store.ts`
- Create: `src/main/storage/secret-store.ts`
- Create: `src/main/storage/storage-errors.ts`
- Create: `src/main/ipc/profile-handlers.ts`
- Modify: `src/main/ipc/register-handlers.ts`
- Modify: `src/shared/contracts.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- `ConnectionProfile` is a discriminated union with `id`, `name`, `groupId`, and non-secret connection fields.
- `ProfileStore.list(): Promise<ConnectionProfile[]>`, `save(profile): Promise<void>`, and `remove(id): Promise<void>` persist validated metadata atomically.
- `SecretStore.set(profileId, secrets): Promise<void>`, `get(profileId): Promise<SecretBundle | undefined>`, and `remove(profileId): Promise<void>` use `safeStorage.encryptStringAsync` and `decryptStringAsync` in the main process.

The shared type definitions in `src/shared/profiles.ts` are:

```ts
export type DatabaseEngine =
  | 'mysql' | 'postgres' | 'sqlserver' | 'oracle' | 'sqlite'
  | 'mongodb' | 'redis' | 'memcached';

export type SecretBundle = Readonly<Record<string, string>>;

export type DatabaseProfile = {
  kind: 'database';
  id: string;
  name: string;
  groupId: string | null;
  engine: DatabaseEngine;
  options: Record<string, string | number | boolean>;
};

export type SshProfile = {
  kind: 'ssh';
  id: string;
  name: string;
  groupId: string | null;
  host: string;
  port: number;
  username: string;
  authentication: 'password' | 'private-key-file' | 'agent';
};

export type ConnectionProfile = DatabaseProfile | SshProfile;
```

- [ ] Implement the shared profile types above and validate each engine's `options` with a Zod schema before persistence or connection.
- [ ] Support the MySQL and MariaDB product labels through the `mysql` engine adapter; preserve the chosen label in the profile's display metadata.
- [ ] Persist profile metadata in an atomic JSON document under `app.getPath('userData')`; write via a sibling temporary file followed by replacement.
- [ ] Persist ciphertext in a separate file; call `safeStorage.isAsyncEncryptionAvailable()` and refuse to save a secret when encryption is unavailable, never falling back to plaintext.
- [ ] Redact secret-shaped properties and connection strings before sending errors to the renderer or logs.
- [ ] Add IPC handlers for profile list/save/remove and secret set/remove; do not expose secret reads except through a connector command.

### Task 4: Build the app shell and profile navigation

**Files:**
- Create: `src/renderer/components/AppShell.tsx`
- Create: `src/renderer/components/ConnectionSidebar.tsx`
- Create: `src/renderer/components/WorkspaceTabs.tsx`
- Create: `src/renderer/components/CommandSearch.tsx`
- Create: `src/renderer/styles/tokens.css`
- Create: `src/renderer/styles/app-shell.css`
- Create: `src/renderer/state/profile-store.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `src/preload/index.ts`

**Interfaces:**
- `ConnectionSidebar` receives `profiles`, `groups`, and `onOpenProfile(profileId)`.
- `WorkspaceTabs` receives workspace descriptors and emits `onSelectWorkspace(id)` and `onCloseWorkspace(id)`.
- The renderer profile store calls only `window.productivityApi.profiles.list/save/remove`.

- [ ] Create an original three-column shell: narrow navigation rail, grouped profile sidebar, and tabbed central workspace.
- [ ] Add accessible keyboard focus, selected-item semantics, and a command search over profile names and open workspace titles.
- [ ] Render empty states for no profiles and no open workspaces without showing fake connection data.
- [ ] Connect profile list/save/remove UI actions to the typed API and display actionable error states.

