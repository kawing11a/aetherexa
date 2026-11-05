# Windows Package Contents

The Windows x64 ZIP contains the Electron runtime, compiled main/preload/renderer output, production dependencies, and rebuilt native modules. `sqlite3` and `node-pty` are native modules and must match the Electron ABI used for the package. Electron Forge rebuilds native dependencies during `make`.

The package excludes source files, `.git`, `.audit`, docs, local environment files, and development-only configuration. User profiles, secrets, known SSH host fingerprints, logs, and local fixtures are created in the user's Electron `userData` directory and are never part of the ZIP.

The Windows x64 `package` command creates three outputs on every successful build: a Squirrel `Setup.exe` installer, a WiX `.msi` installer, and a portable ZIP. It also emits the Squirrel full `.nupkg` package and `RELEASES` manifest. Both installers are unsigned; Windows SmartScreen may show its normal warning. MSI builds require WiX Toolset v3.14.1; the packaging script checks standard install locations and `WIX3_HOME` before running Forge.

The app checks `update.electronjs.org` after launch and hourly when installed from the Squirrel Setup.exe. Updates download in the background; Aetherexa asks whether to restart now or later to apply the downloaded update. This uses Electron's built-in Windows `autoUpdater` and Squirrel's `RELEASES`/`.nupkg` assets. MSI installations do not use the Squirrel updater and are upgraded by installing a newer MSI. Development builds do not check for updates.

Pushing a semantic-version tag such as `v0.1.0` starts [the Windows release workflow](../.github/workflows/release.yml). The workflow builds the MSI, Squirrel Setup.exe, and portable ZIP, then attaches those files together with `RELEASES`, the full `.nupkg`, an SPDX software bill of materials, and third-party license notices to the GitHub Release. It uses the repository's `GITHUB_TOKEN`; no personal token is stored in the app.

The workflow generates the SBOM from the full installed dependency tree, including build tools and the Electron runtime. `scripts/generate-third-party-notices.cjs` writes each SBOM dependency's declared license and bundled license or notice files, including nested vendor files. See [dependency decisions](dependencies.md) for the direct dependency list and license choices.

