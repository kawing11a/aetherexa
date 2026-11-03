# Dependency Decisions

Initial dependency set for the Windows desktop shell. Versions are exact pins from the npm registry checked on 2026-11-03. The implementation pins each direct dependency and records its license, purpose, and packaging caveat below. Native modules are rebuilt against the configured Electron runtime during Forge packaging.

| Package | Version | License | Purpose |
| --- | --- | --- | --- |
| `electron` | 45.2.1 | MIT | Desktop runtime |
| `electron-vite` | 6.0.0 | MIT | Main, preload, and renderer build |
| `@electron-forge/cli` | 8.0.1 | MIT | Application packaging orchestration |
| `@electron-forge/maker-squirrel` | 8.0.1 | MIT | Windows per-user EXE installer |
| `@electron-forge/maker-wix` | 8.0.1 | MIT | Windows MSI package; uses WiX Toolset v3 |
| `@electron-forge/maker-zip` | 8.0.1 | MIT | Windows x64 portable ZIP package |
| `electron-squirrel-startup` | 1.0.1 | MIT | Handles Squirrel install, update, and uninstall startup events |
| `react` / `react-dom` | 19.3.1 | MIT | UI |
| `vite` | 8.3.5 | MIT | Renderer tooling |
| `@vitejs/plugin-react` | 6.2.1 | MIT | React transform |
| `typescript` | 6.0.3 | Apache-2.0 | Type checking and source language |
| `zod` | 4.6.7 | MIT | Runtime validation |
| `@types/node` | 26.6.6 | MIT | Node type declarations |
| `@types/react` / `@types/react-dom` | 19.3.0 | MIT | React type declarations |
| `glob` (override) | 14.0.2 | BlueOak-1.0.0 | Patched Electron packaging transitive dependency |
| `minimatch` (override) | 11.0.1 | BlueOak-1.0.0 | Patched Electron packaging transitive dependency |
| `mysql2` | 3.24.6 | MIT | MySQL and MariaDB protocol driver |
| `pg` | 8.23.1 | MIT | PostgreSQL protocol driver |
| `mssql` | 12.7.13 | MIT | SQL Server protocol driver over Tedious |
| `oracledb` | 26.0.0 | Apache-2.0 OR UPL-1.0 | Oracle Database driver, default Thin mode |
| `sqlite3` | 6.0.1 | BSD-3-Clause | Asynchronous SQLite file access with incremental row callbacks; native module rebuilt for Electron |
| `mongodb` | 7.8.0 | Apache-2.0 | MongoDB protocol driver |
| `redis` | 6.3.1 | MIT | Redis protocol driver |
| `memjs` | 1.3.2 | MIT | Memcached protocol driver |
| `ssh2` | 1.17.0 | MIT | SSH transport and SFTP subsystem |
| `@types/ssh2` | 1.15.6 | MIT | SSH client types |
| `@xterm/xterm` | 6.0.0 | MIT | Terminal emulator UI |
| `@xterm/addon-fit` | 0.11.0 | MIT | Terminal sizing |
| `@xterm/addon-search` | 0.16.0 | MIT | Terminal search |
| `node-pty` | 1.1.0 | MIT | Local PowerShell PTY; native module rebuilt for Electron |

| `pg-cursor` | 2.22.1 | MIT | PostgreSQL cursor-based bounded row streaming |
| `@types/pg-cursor` | 2.7.2 | MIT | PostgreSQL cursor type declarations |
| `@types/mssql` | 12.3.0 | MIT | SQL Server driver type declarations |
| `@types/oracledb` | 26.0.1 | MIT | Oracle driver type declarations |
| `@types/memjs` | 1.3.3 | MIT | Memcached client type declarations |

Windows installer builds use WiX Toolset v3.14.1. The `package` script searches `WIX3_HOME`, the standard WiX v3 install folders, and `%LOCALAPPDATA%\UnifiedProductivity\build-tools\wix3141`. The official portable binaries are available from the [WiX v3.14.1 release](https://github.com/wixtoolset/wix3/releases/tag/wix3141rtm).
