# Unified desktop implementation run

- [x] Read the Principles section of the poteto-mode skill.
- [x] Phase A: Frame the definition of done, scope, blockers, and rigor level.
- [x] Phase B: Design the workflow and record the phases for review.
- [x] Phase C: Run each unit as a hypothesis, make the smallest change, verify the artifact, and keep or revert it.
- [x] Phase D: Keep the decision trail current.
- [x] Phase E: Verify the whole against the definition of done and hand back.
- [x] Shell foundation: complete profile shell, persistence, protected secrets, and secure IPC.
- [x] Database/cache: add the eight approved engine workspaces with connector registry and bounded operations.
- [x] SSH/SFTP: add trusted host-key handling, terminal sessions, file operations, and transfer lifecycle.
- [x] Integration/package: connect workspace routing and write Windows x64 package and recovery docs.
- [x] Runtime/build: typecheck and build/package the Windows x64 artifact; inspect the ZIP manifest, asar contents, and native module presence without adding or running automated tests.
- [x] Review and commit coherent workstream changes on the approved feature branch.

skip: Automated test harness and test execution are excluded by the user-approved implementation roadmap unless the user requests tests or verification.
review: Independent final security review completed; fixes address packaged renderer URL trust, endpoint-scoped SSH fingerprints, versioned credential pointers, Redis scan-pattern continuation, SQL cancellation result races, SQLite interruption reporting, SFTP exclusive creation, and early SSH disconnect delivery.

skip: Packaged UI smoke launch was blocked by the execution policy when starting the generated executable from PowerShell; the CUA policy also blocked launching PowerShell. ZIP/asar inspection and successful typecheck/build/package are recorded; no app data was opened.

## Installer follow-up

- [x] Add Squirrel Setup.exe and WiX MSI makers to the normal Windows package command; preserve ZIP output.
- [x] Add Squirrel startup event handling and stable MSI upgrade identity.
- [x] Pin WiX v3.14.1 locally and create EXE, MSI, and ZIP artifacts from one package run.
- [x] Document WiX prerequisite, output paths, and unsigned installer status.
