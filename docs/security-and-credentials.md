# Security and Credentials

## Local boundary

The renderer runs sandboxed with context isolation and no Node integration. A narrow preload API exposes validated operations. Database, SSH, and SFTP sockets, local file dialogs, private key reads, and credential access are owned by the Electron main process. IPC handlers validate request shapes and reject senders outside the app window. Packaged builds always load the bundled renderer; the development renderer URL is honored only in unpackaged runs, and navigation stays on that renderer origin.

Profiles and SSH host fingerprints are stored under Electron `userData`. Credentials are encrypted with Electron `safeStorage` (Windows-backed protection) before writing to the local secret file. A profile stores a non-secret revision pointer, and the encrypted credential revision is written before the profile switches to it. A crash during an edit therefore leaves the old profile paired with its old credential. Unreferenced revisions can remain if the app closes between switching and cleanup. If the operating system does not offer encryption, credential saving fails closed. The app does not read credentials from Navicat, Termora, or WinSCP.

Setup.exe installations contact `update.electronjs.org` after launch and hourly to check the public Aetherexa GitHub release. The check includes the installed app version and Windows platform so the update service can select a release; connection profiles, credentials, SQL, and SSH data are not sent. MSI and portable ZIP installations do not use this automatic update check.

Public Key authentication reads the private key from the path explicitly supplied in an SSH profile; the matching public key must already be authorized by the SSH server. The private key contents are not copied into the profile file. Passphrases are stored as credentials. Keep private key file permissions and device access under your normal Windows security policy.

## SSH host verification

The first connection asks you to review the server's SHA-256 host fingerprint. Compare it with a trusted administrative source. Later connections must match the saved fingerprint. A mismatch is blocking; only accept the replacement after independently verifying the new fingerprint. Host fingerprints are scoped to the profile, hostname, and port, then removed with that profile. Editing a profile to point at another endpoint requires a fresh first-use review.

## Operational limits

Connection activity goes directly from this computer to the selected endpoint. There is no cloud relay, sync, or telemetry. Query result sizes are bounded; do not assume a canceled write did not reach the server. Check the server state before retrying an operation whose completion is uncertain. A new SFTP upload uses exclusive remote creation, so a file that appears after the overwrite check cannot be silently replaced. Replacing an existing destination requires confirmation. File transfers currently lack a resumable queue; verify partial destinations after network failures.

This project is an early build and has not undergone an independent security audit. Avoid storing production credentials until you have reviewed the implementation and operating environment.
