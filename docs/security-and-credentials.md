# Security and Credentials

## Local boundary

The renderer runs sandboxed with context isolation and no Node integration. A narrow preload API exposes validated operations. Database, SSH, and SFTP sockets, local file dialogs, private key reads, and credential access are owned by the Electron main process. IPC handlers validate request shapes and reject senders outside the app window. Packaged builds always load the bundled renderer; the development renderer URL is honored only in unpackaged runs, and navigation stays on that renderer origin.

Profiles and SSH host fingerprints are stored under Electron `userData` by default. Users can move profile metadata to a shared directory; the active directory pointer remains in `userData`, source profiles are retained, and ID conflicts abort the change. The selected folder may sync connection names, hosts, ports, and other non-secret metadata. Credentials and managed SSH key material stay in `userData` and are encrypted with Electron `safeStorage` (Windows-backed protection). A profile stores a non-secret revision pointer, and the encrypted credential revision is written before the profile switches to it. A crash during an edit therefore leaves the old profile paired with its old credential. Unreferenced revisions can remain if the app closes between switching and cleanup. If the operating system does not offer encryption, credential saving fails closed. The app does not read credentials from Navicat, Termora, or WinSCP.

Setup.exe installations contact `update.electronjs.org` after launch and hourly to check the public Aetherexa GitHub release. The check includes the installed app version and Windows platform so the update service can select a release; connection profiles, credentials, SQL, and SSH data are not sent. MSI and portable ZIP installations do not use this automatic update check.

Public Key authentication can use a legacy private key path or a managed key. The manager reads imported private-key files in the main process and leaves the source files untouched. Managed private-key bytes and passphrases are encrypted in local `safeStorage`; profile metadata contains only the public-key fingerprint. The matching public key must already be authorized by the SSH server. The manager never uploads it automatically. Transient form secrets pass over validated IPC and are not written to profile metadata or logs.

Standalone SFTP connections verify their SSH host key before exposing file operations. FTP transfers use passive mode. Plain FTP sends passwords and file contents without encryption and requires a confirmation each time before connecting. FTPS uses TLS certificate and hostname validation; the app does not provide an insecure-certificate override. FTP and SFTP passwords stay in encrypted local credential storage.

S3 requests are signed in the main process with the AWS SDK. The default credential chain can use environment variables, shared AWS configuration, IAM Identity Center, or an instance role available to the local process. Optional static access keys are encrypted in the local `safeStorage` credential store; bucket and region metadata stays in the selected profile directory. The app does not send AWS credentials to a cloud relay.

## SSH host verification

The first connection asks you to review the server's SHA-256 host fingerprint. Compare it with a trusted administrative source. Later connections must match the saved fingerprint. A mismatch is blocking; only accept the replacement after independently verifying the new fingerprint. Host fingerprints are scoped to the profile, hostname, and port, then removed with that profile. Editing a profile to point at another endpoint requires a fresh first-use review.

## Operational limits

Connection activity goes directly from this computer to the selected endpoint. There is no cloud relay, sync, or telemetry. Query result sizes are bounded; do not assume a canceled write did not reach the server. Check the server state before retrying an operation whose completion is uncertain. A new SFTP upload uses exclusive remote creation, so a file that appears after the overwrite check cannot be silently replaced. Replacing an existing destination requires confirmation. File transfers currently lack a resumable queue; verify partial destinations after network failures.

This project is an early build and has not undergone an independent security audit. Avoid storing production credentials until you have reviewed the implementation and operating environment.
