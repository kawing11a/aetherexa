# Aetherexa AWS S3 file transfer implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` and complete each checkbox in order. This is Phase 3 and depends on `2026-11-03-aetherexa-file-transfer-sftp-ftp.md` and its shared Files API/workspace.

**Goal:** Add AWS S3 buckets as saved file-transfer profiles and browse, upload, download, create prefixes, and delete objects in the existing Files workspace.

**Architecture:** Implement an `S3FileProvider` behind the Phase 2 `FileProviderSession` interface. Profiles are scoped to a bucket and region. Main-process authentication uses the AWS SDK default Node credential provider chain by default, with an optional static access key/secret stored in `SecretStore`. S3 prefixes are displayed as virtual folders; object keys remain opaque to renderer and IPC beyond validated path values.

**Tech Stack:** AWS SDK for JavaScript v3 (`@aws-sdk/client-s3`, `@aws-sdk/lib-storage`), Electron, TypeScript, React, Zod, existing file-provider and encrypted-secret abstractions.

## Shared contracts

- Extend the Phase 2 file-transfer profile union with `protocol: 's3'`, `bucket`, `region`, and `credentialMode: 'default-chain' | 'static'`. Static access key ID and secret access key are secret bundle fields, not profile fields. Do not add custom endpoint, bucket creation, object rename, or non-AWS-compatible provider support.
- Keep `FileProviderSession` and `ProductivityApi.files` operations unchanged. S3 maps the existing path to an object prefix; root is the empty prefix. An S3 entry is either an object (`file`) or a common prefix (`directory`), with size/time where the ListObjectsV2 response provides them.
- S3 deletion is destructive: files delete one object; prefix deletion requires explicit confirmation and deletes only objects below the selected prefix. The UI must show the bucket and prefix in confirmation.

### Task 1: Add S3 profile and credential model

**Files:**
- Modify: `src/shared/profiles.ts`
- Modify: `src/shared/database.ts`
- Modify: `src/shared/database-validation.ts`
- Modify: `src/main/ipc/profile-handlers.ts`
- Modify: `src/renderer/components/FileTransferProfileDialog.tsx`
- Modify: `src/main/storage/profile-store.ts`

- [x] Add a strict S3 file-transfer profile schema with validated bucket name, AWS region, profile name/group, and credentials mode. Use a secret revision for static credentials and keep all secret material outside custom profile directories.
- [x] Add profile form fields for bucket and region, plus default credential chain or static access key ID/secret. Do not request AWS credentials for default-chain profiles.
- [x] Save static credential bundles through the existing encrypted `SecretStore` path and clear transient renderer values after submit; remove old secret revisions using the existing safe profile-save lifecycle.
- [x] Add S3 to the Files protocol chooser and all profile validation/list/migration paths without changing SFTP/FTP forms.
- [x] Run `npm run typecheck` and `npm run build`.

### Task 2: Implement S3 file provider

**Files:**
- Add dependencies: `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`
- Create: `src/main/files/s3-provider.ts`
- Modify: `src/main/files/file-session-manager.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/ipc/register-handlers.ts`

- [x] Create an S3 client in the main process using the profile's region and either the default Node credential provider chain or static credentials resolved from `SecretStore`. Never serialize credentials into session descriptors or log the client config.
- [x] Implement `list` with `ListObjectsV2` and continuation-token pagination, merge `Contents` and `CommonPrefixes`, cap at 10,000 visible entries and return a safe actionable error when a prefix exceeds the cap.
- [x] Normalize prefixes without allowing traversal or accidental bucket-root deletion; map folder creation to an empty marker object only if required for visibility, and treat prefixes as virtual otherwise.
- [x] Implement upload through `@aws-sdk/lib-storage` multipart `Upload` with progress events and abort on disconnect. Use main-process open-file and save-file dialogs for upload/download paths.
- [x] Implement downloads through `GetObject` streams with progress and clean up partial destination files on failure. Handle overwrite with an explicit main-process confirmation.
- [x] Implement object delete and recursive prefix delete only after user confirmation; never implement rename as a copy/delete shortcut. Convert AWS errors into safe actionable codes without including credentials, signed URLs, or raw response bodies.
- [x] Close/destroy S3 clients and abort in-flight transfers on disconnect, profile deletion, renderer destruction, and app shutdown.
- [ ] Run typecheck/build and manually verify default-chain and static-secret connections, pagination, large upload, download, empty-prefix creation, object delete, recursive-prefix confirmation, and permission-denied errors against a test bucket.

### Task 3: Finish Files workspace and user documentation

**Files:**
- Modify: `src/renderer/workspaces/FilesWorkspace.tsx`
- Modify: `src/renderer/components/FileTransferProfileDialog.tsx`
- Modify: `src/renderer/styles/database-workspaces.css`
- Modify: `docs/user-guide.md`
- Modify: `docs/security-and-credentials.md`

- [x] Reuse the same browser layout for S3 and show bucket plus current prefix in breadcrumbs; display objects and virtual prefixes using the provider-neutral entry type.
- [x] Show capability-appropriate controls: list, upload, download, create prefix, and delete; omit rename and bucket-creation actions.
- [x] Show AWS authentication mode and bucket/region in the connection status without revealing static credentials.
- [x] Confirm delete with the exact object key or prefix, including bucket name; explain that deleting a prefix removes all objects beneath it.
- [x] Document the default credential chain, optional local encrypted static credentials, bucket/region scoping, virtual prefixes, delete behavior, and lack of object rename.
- [ ] Run typecheck/build and manually verify SFTP and FTP flows still work alongside S3 and existing SSH/database workflows.

## Handoff

This completes the three approved delivery phases. Prepare MSI and EXE builds using the existing packaging commands after implementation, but publish a GitHub release only as separately authorized for this feature release.
