# Aetherexa Rebrand, Open-Source Release, and Updates Design

**Date:** 2026-11-03  
**Status:** Design approved; awaiting review of this written spec  
**Repository:** `kawing11a/aetherexa`

## Goal

Rename the Windows database, SSH, and SFTP desktop application to Aetherexa, publish it as an MIT-licensed open-source project, and let EXE-installed users receive GitHub Releases in the background and apply them by restarting the app.

## Product identity and existing user data

Use Aetherexa consistently in package metadata, window title, renderer branding, executable and installer labels, Windows shortcuts, and the README. Use the user-provided purple line-art icon for the app executable, setup executable, and MSI. Preserve the existing WiX upgrade code so a newer MSI remains an in-place Windows Installer upgrade.

Changing Electron's product name changes its default Windows `userData` directory. On first launch after the rename, move the existing `%APPDATA%/Unified Productivity` directory to `%APPDATA%/Aetherexa` only when the old directory exists and the new directory does not. Never overwrite an existing Aetherexa data directory. The migration must retain profiles, protected secrets, host-key records, and other app data. An explicit `UNIFIED_PRODUCTIVITY_DATA_DIR` override continues to take precedence.

## Open-source project documentation

Add a README describing Aetherexa, supported database and cache engines, SSH and SFTP features, Windows requirements, development and packaging commands, data and credential handling, release process, and updater behavior. Add the MIT license using the repository owner `kawing11a` as the copyright holder. Identify the source repository as `https://github.com/kawing11a/aetherexa` in package metadata and documentation.

## GitHub release pipeline

Keep producing the Squirrel Setup.exe, WiX MSI, and portable ZIP for every successful Windows x64 package build. A pushed semantic-version tag such as `v0.1.0` runs the Windows GitHub Actions workflow and creates a GitHub Release with:

- The Aetherexa Setup.exe and MSI installers.
- The portable ZIP.
- Squirrel's `RELEASES` manifest and full `.nupkg` update package, required by the in-place updater.

The workflow sets the packaged app version from the tag and grants only the repository contents permission needed to publish the release assets. It uses GitHub's workflow token; no personal access token is added to source or app configuration.

## In-place update behavior

Use Electron's built-in Windows `autoUpdater` with the public `update.electronjs.org` feed for `kawing11a/aetherexa`. Initialize it only for packaged Windows builds. Check on launch after Squirrel's first-run lock has cleared, periodically, and when the user checks in Settings. When an update is available, download it in the background. When ready, offer **Restart now** or **Later**; restarting applies the update without asking the user to download or run the Setup.exe again. Show checking, current, downloading, ready-to-restart, and recoverable error states in the Settings update view. Do not check for updates in development builds.

The in-place flow applies to installations made with the Squirrel Setup.exe. The MSI remains available for enterprise deployment and is upgraded by applying a newer MSI through Windows Installer. MSI-installed copies are not enrolled in the Squirrel updater.

## Boundaries and failure handling

- Use HTTPS for the update feed and only the configured public repository.
- If GitHub is unavailable or the feed reports an error, keep the current app usable and present a retry option.
- Do not report an update as installed before the user restarts and the new app launches.
- Preserve app data when updating; updater downloads and installs do not include profile or credential files.
- The first GitHub release must use a valid SemVer tag and attach every Squirrel asset. Later releases must retain the same Squirrel package identity so existing EXE installs can update.

## Verification

Run TypeScript type checking, build the production app, and package Windows x64 outputs. Confirm the MSI, Setup.exe, ZIP, `RELEASES`, and full `.nupkg` are present, and inspect the release workflow's asset list and repository settings. Do not publish until the built artifacts and committed release version are ready.

## Release execution

After implementation and verification, commit the Aetherexa source changes, push the source and `v0.1.0` tag to the empty public repository `kawing11a/aetherexa`, wait for the tag workflow to finish, and confirm that the release contains the MSI, Setup.exe, ZIP, `RELEASES`, and `.nupkg` assets.
