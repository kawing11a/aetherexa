# Unified Productivity Desktop Design

**Date:** 2026-11-03  
**Status:** Approved design; awaiting written-spec review before implementation planning

## Summary

Build a Windows-first desktop workspace that brings database management, SSH terminal work, and SFTP file transfer into one application. It will use the installed Navicat Premium 17, Termora, and WinSCP only as workflow references. The implementation will use original code, UI, and assets, with direct connections to the standard database and SSH protocols.

## Goals

- Manage connections for MySQL/MariaDB, PostgreSQL, SQL Server, Oracle, SQLite, MongoDB, Redis, and Memcached.
- Provide a useful database workspace for each engine family: SQL object browsing and query results for relational databases; collection/document browsing for MongoDB; key/value and server tools for Redis and Memcached.
- Provide SSH terminal tabs and SFTP file transfer in the same window, with terminal and SFTP able to share an SSH session.
- Keep connection profiles and credentials local to the Windows device.
- Establish extension points so protocol-specific capabilities remain in their own adapters.

## Non-goals for the first release

- Reproduce Navicat, Termora, or WinSCP source code, branding, or proprietary assets.
- Match every feature of those products. BI, visual data modeling, scheduled automation, and broad backup/restore tooling are later work.
- Read or import stored passwords from the reference applications. Users enter credentials into this app; a future profile import may bring non-secret connection metadata only.
- Provide a cloud relay or synchronization service. Database, SSH, and SFTP traffic goes directly from the desktop to the selected endpoint.

## Product shape

The main window has a grouped connection and host sidebar, a workspace tab strip, and a central work area. Search and a quick switcher make saved profiles and open workspaces reachable without expanding the full tree.

- **Relational database tabs:** schema/object tree, SQL editor, and tabular results. Initial common operations are connect, browse schemas and tables, run a query, inspect rows, and export a result locally.
- **MongoDB tabs:** database/collection tree and document-oriented query and result views.
- **Redis tabs:** key browser and command view with type-aware value inspection.
- **Memcached tabs:** server statistics and key/value tools that clearly expose protocol limitations, including what cannot be enumerated by a server.
- **SSH tabs:** terminal sessions with multiple host tabs and a local shell option.
- **SFTP tabs:** local and remote file panes, a transfer queue with progress, cancellation and retry, and clear reporting when a transfer is partial or fails.

The visual language will be original. Navicat's connection grouping, object navigation, editor tabs, and action toolbar, plus Termora's terminal tab workflow, inform task flow. WinSCP is included as a capability reference through its installed folder and managed API metadata; its file-manager UI was not observed in this pass.

## Architecture

Use Electron with a TypeScript/React renderer and a narrow, typed preload API. Keep `nodeIntegration` disabled, enable context isolation and renderer sandboxing, and let the main process own credentials, network sessions, filesystem access, and connector invocation.

The main process hosts a connector registry with separate adapters for the eight requested engines and an SSH session service. UI components call typed application commands and receive structured events for connection state, query progress, terminal output, and transfer progress. A database adapter declares its capabilities so unsupported operations are hidden or explained per engine instead of being simulated.

The terminal renders with xterm.js. Local shell sessions use a PTY service; remote terminal and SFTP operations use SSH sessions. When a profile opens both views, the session manager may share the authenticated SSH connection while keeping terminal channels and file operations isolated.

Credentials are stored through Windows-protected local storage (Credential Manager or DPAPI-backed storage, selected during implementation research). Profile metadata and app preferences remain local. Secrets are never written to logs, crash reports, or exported profile files.

## Data flow and security boundaries

1. The user selects a saved profile or enters connection details.
2. The renderer sends a typed request through the preload API; it never receives a raw credential-store handle or unrestricted Node access.
3. The main process retrieves any secret, creates the protocol session, and streams bounded status/results to the renderer.
4. Database results and file transfers remain on the user's machine and the configured endpoint. No intermediary service is used.

The first connection to an SSH host presents its host key for review and storage. A changed host key produces a blocking error with the mismatch details; the application will not offer a silent bypass. TLS and database certificate options are explicit in each profile. Logs redact passwords, private keys, tokens, and connection strings.

## Failure behavior

- Show connection state and a useful protocol error beside the affected profile or tab.
- Preserve editor contents and result context when a connection drops.
- Do not automatically repeat mutating database commands after a timeout or lost connection.
- Keep long queries and transfers cancellable where the protocol permits it; distinguish cancellation from failure and report partial transfers.
- Set timeouts and bounded output sizes per operation. Report when an engine lacks a feature instead of returning misleading empty data.

## Delivery phases

1. **Desktop foundation:** app frame, grouped profiles, typed connector contract, protected local credential storage, settings, and Windows packaging.
2. **Database workspaces:** implement and document baseline connection, browsing, querying, and result behavior across MySQL/MariaDB, PostgreSQL, SQL Server, Oracle, and SQLite.
3. **Document and cache workspaces:** add MongoDB collection/document workflows, Redis key/command workflows, and Memcached statistics/value workflows.
4. **Remote workspaces:** add local and SSH terminals, shared SSH session lifecycle, SFTP panes, transfer queue, host-key handling, and recovery behavior.
5. **Integration and release readiness:** consistent navigation, keyboard behavior, error states, credential safeguards, packaging, and user documentation.

Each phase is independently reviewable and should leave the app usable for its completed workflows. The phase order may change if implementation research finds a concrete driver or runtime constraint.

## Verification plan

Use behavior-focused unit tests for profile validation, adapter capability reporting, secret redaction, and transfer state. Use disposable local services for protocol integration checks and Windows smoke checks for packaging, credential storage, tab lifecycle, cancellation, and error presentation. Never point verification at the user's existing saved connections or production data. This plan describes future verification; no tests have been added or run as part of design approval.

## Evidence and limits

REA 6.8.0 statically inventoried the installed application folders and inspected PE import data for Navicat and Termora plus managed metadata for WinSCP's `WinSCPnet.dll`. The UI reference pass observed Navicat's connection/object workspace and Termora's terminal-tab model; WinSCP's file-manager UI was not captured. These observations support workflow and platform choices, not claims about internal algorithms. REA's Windows environment had no Ghidra, Hopper, or other native decompiler configured, so native function analysis was not performed. The product design does not depend on access to proprietary internals.

## Open implementation decisions

- Select and pin maintained protocol drivers and assess their exact Windows packaging and licensing.
- Confirm Oracle driver mode and any client-library requirements before implementation.
- Choose the concrete Windows credential-storage library and recovery behavior.
- Define first-release query export formats and supported SFTP file operations during implementation planning.
