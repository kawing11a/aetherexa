# Data section sidebar

## Why

The workspace needs a clearer way to browse saved Database, Bucket, SSH, and FTP / SFTP profiles, while reducing repeated typing during profile creation. The left panel should organize profiles into groups and expose the current section’s add actions directly.

## Interaction

- The left navigation rail expands to show section icons and labels and collapses to icons only.
- The four sections are Database, Bucket, SSH, and FTP / SFTP.
- Selecting a section filters the profile tree to matching saved profiles. The tree remains visible when the rail is collapsed.
- The section header identifies the current section and shows the active profile when it belongs to that section.
- The Add control opens a menu with Add profile and Add group.
- Add group opens a name dialog. Groups remain reusable across sections.
- Add profile opens a wizard scoped to the current section. When invoked from a named group, that group is preselected.
- Profiles appear under their group. Profiles without a group use a separate No group branch.
- The same actions are available through right-click and a visible overflow control. Keyboard context-menu key and Shift+F10 are supported; Escape and outside click dismiss the menu.
- Settings remains a utility action, not a fifth section. Existing workspace tabs and views remain available while browsing sections.

## Wizard and reuse behavior

Database, Bucket, and SSH each open their relevant wizard directly. FTP / SFTP opens a protocol chooser restricted to SFTP, FTP, explicit FTPS, and implicit FTPS. The general New connection action keeps its broad type chooser. Existing profile templates and remembered field values remain available for their compatible profile type; copied and remembered data excludes secrets and private-key material.

## Data ownership

`AppShell` continues to own profile data, the global catalog, workspace state, and wizard drafts. `ConnectionSidebar` owns transient navigation state. Existing catalog group names remain global to preserve storage compatibility. A profile’s assigned group controls its position in every section where it appears.

## Acceptance criteria

- All four sections show only their matching profile types.
- Expanded and collapsed navigation modes show the expected labels and icons.
- Add profile is section-scoped; Add group creates a reusable group.
- A profile added from a group starts with that group selected.
- Group and profile trees support context actions from mouse and keyboard.
- Current active profile information is accurate for the selected section.
- Existing workspace tabs do not reset when switching sections.
