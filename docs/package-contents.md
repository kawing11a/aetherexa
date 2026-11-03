# Windows Package Contents

The Windows x64 ZIP contains the Electron runtime, compiled main/preload/renderer output, production dependencies, and rebuilt native modules. `sqlite3` and `node-pty` are native modules and must match the Electron ABI used for the package. Electron Forge rebuilds native dependencies during `make`.

The package excludes source files, `.git`, `.audit`, docs, local environment files, and development-only configuration. User profiles, secrets, known SSH host fingerprints, logs, and local fixtures are created in the user's Electron `userData` directory and are never part of the ZIP.

The first deliverable is an unsigned portable ZIP. Windows SmartScreen may show its normal warning for unsigned software. The app does not include an updater or telemetry.

Inspect the package before sharing it. Add an SBOM and per-dependency notices before a public release; see [dependency decisions](dependencies.md).

