# Unified Productivity Desktop

A Windows desktop app that brings database, cache, SSH terminal, and SFTP workspaces together. It uses original UI and direct protocol connections; Navicat Premium 17, Termora, and WinSCP were workflow references only.

## Current scope

- MySQL / MariaDB, PostgreSQL, SQL Server, Oracle, SQLite
- MongoDB, Redis, Memcached
- SSH terminal, local PowerShell terminal, and basic SFTP browsing and file transfers
- Local connection profiles; credentials encrypted with Electron safeStorage on Windows

The current build is an early foundation. See the [user guide](docs/user-guide.md), [security notes](docs/security-and-credentials.md), [package contents](docs/package-contents.md), and [dependency decisions](docs/dependencies.md) for setup and limitations.

## Build on Windows x64

Use a supported Node.js LTS release and npm. Native modules (`sqlite3` and `node-pty`) must rebuild against the bundled Electron version; Electron Forge runs its native dependency rebuild during packaging.

```powershell
npm ci
npm run typecheck
npm run build
npm run dev
npm run package
```

The portable ZIP is produced under `release/make/zip/win32/x64/`. Packaging creates a local package and does not publish or sign it.

## Data location

Application data is stored under Electron's per-user `userData` directory. For isolated portable or diagnostic runs, set `UNIFIED_PRODUCTIVITY_DATA_DIR` to an explicit directory before launch. On Windows this is normally `%APPDATA%\Unified Productivity`. The profile file contains connection metadata; the secret store is encrypted by Windows-backed Electron safeStorage. SSH host fingerprints are in a separate local file. There is no cloud sync or relay.


