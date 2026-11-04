# Aetherexa

Aetherexa is an open-source Windows desktop workspace for database administration, SSH terminals, and file transfers over SFTP, FTP/FTPS, and AWS S3. It connects directly to your services and keeps connection profiles and credentials on your PC.

Repository: [github.com/kawing11a/aetherexa](https://github.com/kawing11a/aetherexa)

## Features

- Database and cache connections for MySQL/MariaDB, PostgreSQL, SQL Server, Oracle, SQLite, MongoDB, Redis, and Memcached.
- SSH authentication with password, public key, or SSH Agent.
- Remote SSH terminal tabs, a local PowerShell terminal, and a separate Files workspace for SFTP, FTP/FTPS, and AWS S3.
- A local SSH key manager to import or generate Ed25519/RSA keys, protect them with Electron `safeStorage`, and select them from connection profiles.
- A configurable shared folder for connection metadata; passwords, private keys, and static AWS secrets remain encrypted in local app data.

The application is under active development. See the [user guide](docs/user-guide.md), [security and credential notes](docs/security-and-credentials.md), [package contents](docs/package-contents.md), and [dependency decisions](docs/dependencies.md) for current capabilities and limitations.

## Install

Download the latest files from [GitHub Releases](https://github.com/kawing11a/aetherexa/releases):

- **Setup.exe** is the recommended per-user installation. It checks for updates in the background, downloads them, and asks you to restart Aetherexa to apply the update.
- **MSI** is intended for managed deployments. Administrators update it with a newer MSI through Windows Installer.
- **Portable ZIP** runs without an installer and does not receive automatic updates.

Windows may show a SmartScreen notice because the installers are not code-signed.

## Build on Windows x64

Install Node.js 22 and npm. MSI packaging also requires WiX Toolset 3.14.1; the packaging script checks `WIX3_HOME`, standard install locations, `%LOCALAPPDATA%\Aetherexa\build-tools\wix3141`, and the previous Unified Productivity build-tools cache.

```powershell
npm ci
npm run typecheck
npm run dev
npm run package
```

`npm run package` creates Setup.exe, MSI, and portable ZIP outputs under `release/make/`. It also creates Squirrel's `RELEASES` manifest and full `.nupkg` package used by the in-place updater. Packaging writes local artifacts; pushing a `v*` version tag runs [the Windows release workflow](.github/workflows/release.yml), which builds and attaches the installers and update metadata to a GitHub Release.

## Local data and security

Profiles, encrypted credentials, and SSH host fingerprints are stored in Electron's per-user data directory, normally `%APPDATA%\Aetherexa`. On the first Aetherexa launch, data from the former `%APPDATA%\Unified Productivity` directory is moved when the new directory does not already exist. The old `UNIFIED_PRODUCTIVITY_DATA_DIR` environment variable remains supported for isolated runs and custom data locations.

Credential encryption uses Windows-backed Electron `safeStorage`. Aetherexa does not include cloud sync or a relay service. See [security and credentials](docs/security-and-credentials.md) for details.

## Contributing

Issues and feature requests are welcome in the [GitHub issue tracker](https://github.com/kawing11a/aetherexa/issues). For code changes, build on Windows x64 and include a clear description of the behavior changed. Do not include real connection credentials, private keys, or production data in issues or pull requests.

## License

Aetherexa is available under the [MIT License](LICENSE).
