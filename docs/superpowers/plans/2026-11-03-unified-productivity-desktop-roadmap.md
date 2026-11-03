# Unified Productivity Desktop Implementation Roadmap

> **For agentic workers:** Use `superpowers:executing-plans` for inline work, or `superpowers:subagent-driven-development` if the user selects subagent-driven execution. Follow one workstream plan at a time and review each deliverable before starting the next.

**Goal:** Deliver one Windows desktop application for SQL and document databases, Redis/Memcached, SSH terminals, and SFTP transfers.

**Architecture:** A hardened Electron shell hosts a React/TypeScript UI. Main-process services own profiles, protected secrets, protocol sessions, and filesystem operations; typed preload APIs expose only the operations each workspace needs.

**Tech Stack:** Electron, TypeScript, React, Vite, xterm.js, protocol-specific Node drivers, and Electron `safeStorage` asynchronous APIs.

## Global Constraints

- Windows is the first supported desktop platform.
- Support MySQL/MariaDB, PostgreSQL, SQL Server, Oracle, SQLite, MongoDB, Redis, and Memcached.
- The app makes direct client-to-endpoint connections and has no cloud relay.
- Credentials remain local, are protected with Windows DPAPI through Electron `safeStorage`, and never enter logs or exports.
- Use `safeStorage.isAsyncEncryptionAvailable`, `encryptStringAsync`, and `decryptStringAsync`; Electron documents the synchronous string APIs as deprecated ahead of removal in Electron 46. See [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).
- Renderer Node integration remains disabled; context isolation and renderer sandboxing remain enabled.
- Follow Electron's current recommendations for renderer isolation, CSP, navigation, and sender-validated IPC. See [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security).
- Do not copy proprietary source, branding, or assets from Navicat, Termora, or WinSCP.
- Do not read saved secrets from the reference apps.
- No automated tests are added or run in this work unless the user asks for testing or verification.

---

## Workstream order

1. [Shell and profile foundation](2026-11-03-shell-and-profile-foundation.md)
2. [Database and cache workspaces](2026-11-03-database-and-cache-workspaces.md)
3. [SSH terminal and SFTP workspaces](2026-11-03-ssh-terminal-and-sftp.md)
4. [Integration and Windows packaging](2026-11-03-integration-and-packaging.md)

Workstreams 2 and 3 depend on workstream 1. Workstream 4 depends on all three. Connector package selection, package licenses, and Oracle runtime requirements are recorded as concrete implementation decisions in workstream 1 before dependencies are added. Memcached key browsing must not imply that every key can be listed; the [Memcached FAQ](https://docs.memcached.org/userguide/faq/) warns applications not to rely on reading all keys.

## Shared file map

- `package.json`, `electron.vite.config.ts`, `tsconfig.json`: package scripts, Electron/Vite build entries, and strict TypeScript settings.
- `src/main/index.ts`, `src/main/window.ts`: application lifetime and secure `BrowserWindow` construction.
- `src/main/ipc/register-handlers.ts`: validated IPC request registration.
- `src/preload/index.ts`: narrow typed API exposed to the renderer.
- `src/shared/contracts.ts`: profiles, connector capabilities, workspace events, and request/result types.
- `src/main/storage/profile-store.ts`: validated, atomic profile persistence under Electron's user-data directory.
- `src/main/storage/secret-store.ts`: asynchronous `safeStorage` encryption/decryption for profile secrets.
- `src/renderer/App.tsx`, `src/renderer/components/AppShell.tsx`: app frame, navigation, and workspace tabs.
- `src/renderer/styles/tokens.css`: original theme tokens and accessible focus states.

The database and remote workstream plans define their own focused files and interfaces. No generated secrets or production connection data belong in the repository.

## Implementation sequencing

- Complete and review each workstream's code before moving to dependent work.
- Preserve the approved feature boundaries: engine-specific views, shared profile/navigation shell, and separate terminal/SFTP channels over a managed SSH session.
- Do not connect to saved production profiles during implementation. Use local disposable services only if the user later requests verification.

