# Aetherexa connection storage, key manager, and file transfer design

## Goal

Extend Aetherexa so users can choose where shared connection profiles are stored, manage SSH keys without typing key paths into connection forms, and use SFTP, FTP/FTPS, and AWS S3 from a separate file transfer workspace.

## Current behavior

- Database and SSH profiles are stored together in `%APPDATA%\\Aetherexa\\profiles.json` through `ProfileStore`.
- Profiles can be grouped by a free-text `groupId`.
- Passwords and SSH passphrases are encrypted by Electron `safeStorage` in the application data directory.
- SSH public-key authentication reads a private-key file from `privateKeyPath` in the profile.
- SFTP sessions are opened from an existing SSH session and shown beside its terminal.
- FTP and S3 connections are not implemented.

## Connection profile directory

Add a Connections setting that lets the user choose one shared directory for all database, SSH, and file transfer profile metadata. Store the active directory setting in Aetherexa's normal application data directory, and store profile metadata in `profiles.json` inside the selected directory. On a fresh install, use the existing application data location as the default.

The custom directory contains non-secret profile fields such as connection names, host names, user names, ports, regions, and bucket names. Passwords, passphrases, AWS secret access keys, and SSH private-key contents remain in the local `safeStorage`-protected store and are not written to the selected directory. The UI explains that connection metadata may be synchronized if the selected directory is inside a cloud-synced folder.

When a user chooses a directory that does not contain Aetherexa profiles, migrate the current `profiles.json` atomically and then switch the active path. If the target already contains Aetherexa profiles, offer a merge keyed by profile ID. Keep target entries on matching IDs when their parsed data matches; stop and explain any conflicting ID rather than overwriting either copy. Do not delete the source file after migration. If validation or writing fails, keep using the previous directory and report a safe error. Existing installations retain their current profile directory until the user changes it.

## SSH public-key manager

Add a key manager reachable from Settings and from SSH/SFTP authentication forms. It supports importing an existing private key and generating a new key pair. For generated keys, offer Ed25519 as the default and RSA 4096 for servers that require RSA compatibility. The manager shows a user-editable label, key type, public-key fingerprint, and public-key text. Users can edit the label, copy the public key, and export the public key as a `.pub` file. The manager does not upload a key to a server.

Store private-key material only in the existing local `safeStorage`-protected credential store. Keep private-key bytes in the main process; expose only key IDs, labels, types, fingerprints, and public-key text to the renderer. Connection profiles store the SHA-256 public-key fingerprint, not private-key text or a path, so profiles can resolve the same key after it is imported on another device. Imported passphrases remain encrypted locally. Editing a key means changing its label or passphrase metadata; changing key material is done by importing or generating a replacement.

SSH and SFTP connection forms select a key from the manager and provide a **Manage keys** action. The manager can generate a new key and return the selected key reference to the connection form. Existing profiles with `privateKeyPath` continue working. Their edit form offers an explicit import action that stores the key in the manager and switches the profile to the key reference after successful import. Never remove or modify the user's original key file during import.

## Independent file transfer workspace

Add a separate **Files** navigation entry and a shared file-browser workspace. A file-transfer profile is independent from a terminal SSH profile. Users can save multiple SFTP, FTP/FTPS, and S3 profiles, connect directly from the Files workspace, and keep the terminal closed.

### SFTP

Open SFTP directly over SSH using its own saved host, port, username, host-key verification state, and authentication choice. Reuse SSH password and agent authentication and the public-key manager. Reuse existing remote path validation and transfer progress behavior where it fits, without requiring an SSH terminal profile or terminal session.

### FTP and FTPS

Support standard FTP, explicit FTPS, and implicit FTPS with passive transfers. Require certificate validation for FTPS. Clearly warn before connecting with plain FTP because it does not encrypt credentials or file contents. Save passwords only in the encrypted local store.

### AWS S3

Support AWS S3 buckets and objects, with each saved profile scoped to a bucket and AWS region. Allow the AWS default credential provider chain and an optional static access key stored in `safeStorage`. Browse object prefixes, upload and download objects, create prefixes, and delete objects with confirmation. Display S3 directories as virtual prefixes. Do not present rename as an atomic operation; it is not part of the first S3 release.

## Shared file-browser behavior

Use one renderer file-browser experience for SFTP, FTP/FTPS, and S3, backed by protocol-specific main-process adapters. Show connection state, current path or prefix, file name, type, size, modified time when available, transfer progress, and safe actionable errors. Provide connect/disconnect, navigation, upload, download, create-directory/prefix, and delete operations. Confirm destructive remote deletes. Show unsupported actions as disabled or omit them when a provider does not support them.

All network clients, private-key reads, AWS signing, filesystem dialogs, and transfer streams stay in the Electron main process. Expose narrow typed preload APIs. Validate IPC senders and inputs. The renderer may hold a secret briefly while the user types it into a form, but it must submit it only over validated IPC, clear it after the operation, and never persist it to local storage, profile metadata, logs, or error messages. Private-key bytes never cross into the renderer; stored secrets are never returned from main-process IPC.

## Compatibility and migration

- Existing database and SSH profiles keep their IDs and connection behavior.
- Existing profile groups remain available; this work does not replace them with filesystem folders.
- Existing path-based SSH profiles continue to connect until the user explicitly imports a key into the manager.
- The current local `safeStorage` credentials and known-host records stay in the existing application data directory when the profile directory changes.
- A copied or synchronized profile directory does not copy credentials or private keys. On another device, users must add its credentials and keys to that device's local manager.
- SFTP uses host-key verification before file access, matching current SSH behavior.

## Delivery phases

1. Add selectable profile storage and its safe migration, then add the local SSH key manager, SSH key selection, and legacy key import.
2. Add the separate Files workspace and standalone SFTP connections, then FTP/FTPS connections through the shared file-browser interface.
3. Add AWS S3 bucket profiles and object operations through the same interface.

Each phase must preserve the existing database, SSH terminal, and SFTP workflows. Phase 1 is the foundation for the file-transfer profiles. The Files workspace should be designed in phase 1 so the profile types and navigation can accept later protocol adapters without moving existing connections.

## Out of scope

- Synchronizing credentials or private keys between devices.
- Automatically installing SSH public keys on remote servers.
- S3-compatible non-AWS endpoints, bucket creation, or object rename.
- Replacing the existing database and SSH terminal workspaces.
- Making remote file operations run through a cloud relay.

## Acceptance criteria

- Users can select a shared profile directory, restart the app, and see the same profiles without losing or overwriting data.
- Profiles stored in the selected directory contain no passwords, passphrases, private-key material, or static AWS secret keys.
- Users can import or generate an SSH key, edit its label, copy/export its public key, and select it from SSH/SFTP forms without typing a path.
- Existing path-based SSH profiles continue to work and can be explicitly imported into the manager.
- Users can open SFTP directly from the Files workspace without first opening a terminal or saving an SSH terminal connection.
- The Files workspace can browse and transfer files over SFTP, FTP/FTPS, and S3 using provider-appropriate capabilities and safe errors.
- Plain FTP warns about unencrypted traffic; FTPS validates certificates; SFTP validates host keys; S3 static secrets remain encrypted locally.
- IPC validates every new operation; private-key bytes and stored credentials are never returned to the renderer, and transient form values are never persisted or logged.
