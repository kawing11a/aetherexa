# User Guide

## Application updates

When installed with Aetherexa Setup.exe, open Settings to check for an update. The app also checks after startup and about once an hour, downloads available updates in the background, and offers to restart when the update is ready. A newer MSI is applied through Windows Installer by your administrator. Portable ZIP builds do not update themselves.

## First launch and profiles

Create a database or SSH profile from the sidebar. SSH authentication offers Password, Public Key, and SSH Agent. Public Key mode reads the matching private key file locally; its optional passphrase is entered into the secure credential field. Database passwords are entered into the secure credential field; leaving a credential blank while editing keeps its existing saved value. SQLite profiles point to a local database file.

In Settings, choose a shared Connections folder for profile metadata. Aetherexa merges profiles by ID, keeps matching entries once, and stops on conflicting IDs; the previous profile file is retained. Passwords and private keys remain in this PC's encrypted app data. Settings also opens the SSH key manager, where you can import a key, generate Ed25519 or RSA-4096, rename it, change its passphrase, copy its public key, or export a `.pub` file. SSH profiles can select a managed key; older profiles using a key path continue to work until you import the key.

## Database workspaces

Open a saved profile to start its workspace. Relational engines provide a schema/object browser, SQL editor, and bounded result pages. MongoDB provides database/collection browsing and JSON filter queries. Redis provides key scanning and tokenized command execution. Memcached provides server statistics and key operations when you already know the key.

Set TLS explicitly for network database profiles. Oracle DML uses autocommit so a successful write is committed when the statement completes. The first build exposes a baseline set of operations; it does not provide full Navicat parity, visual modeling, backup scheduling, or every engine-specific administration feature. Memcached has no standard way to enumerate all keys, so the UI does not promise a complete key browser.

## SSH and SFTP

Open an SSH profile and choose **Connect**. On first connection, compare the SHA-256 host fingerprint with a value obtained through a trusted channel before accepting. If a saved fingerprint changes, the app blocks connection until you confirm the replacement. Rejecting or dismissing the prompt leaves the connection closed.

The SSH workspace opens an interactive terminal and SFTP listing. Select a directory to navigate. Use **Upload** to choose a local file; an existing remote filename triggers a second confirmation. Select a remote file to download through the Windows save dialog. **＋ Folder** creates a directory. Use **Local PowerShell** to open a local terminal without connecting to a host.

The initial SFTP workspace covers browse, create-directory, upload, and download. Rename, delete, dual local/remote panes, queued/cancellable transfers, and retry recovery are not included yet. A dropped connection can leave a transfer incomplete; inspect the remote or local destination before repeating it.

Use the **Files** navigation entry to create an independent SFTP, FTP, or FTPS profile. SFTP connects directly and does not open an SSH terminal; it supports password, managed public key, and SSH Agent authentication. FTP profiles use passive transfers. Plain FTP displays an unencrypted-traffic warning before connecting. Explicit and implicit FTPS require a trusted certificate. The Files browser can create folders and delete entries; deleting an FTP folder also removes its contents.

Files also supports AWS S3 bucket profiles scoped to a region. Choose the default AWS credential chain or enter a static access key that Aetherexa stores encrypted on this PC. S3 folders are virtual prefixes; creating one adds an empty marker object. Deleting a prefix deletes every object below it after the confirmation names the bucket and prefix. S3 object rename and bucket creation are not available.

## Reset local state

To reset app state, close the app and back up then remove its userData files. This removes saved profiles, encrypted credentials, and host fingerprints; it does not change any remote database, server, or files. Removing a profile inside the app also closes its sessions and removes its associated credentials and SSH fingerprint.

See [Security and credentials](security-and-credentials.md) for storage details and [Package contents](package-contents.md) for distribution notes.

