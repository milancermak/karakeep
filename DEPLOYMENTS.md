# Deployments

Numbering begins with recorded history; earlier deployments have not been reconstructed.

## Deployment 1

- Completed: 2026-10-29T13:48:44.927Z
- Target: local macOS Firefox Nightly, all current-user profiles
- Outcome: Local XPI and all-profile Nightly policies staged; activation pending browser restart.
- Revision boundary: unknown..4ab2cf8c106e9a36dbd68ee1bc5a02c53db218b8
- Source: uncommitted working tree based on the to revision; the commit hash alone does not identify this build
- Artifact: Karakeep Local 1.0.1; SHA-256 `99a0f0106893cbc7768ce156c5d095a2485d48b4a4ca373e4028a9e64dabc41f`
- Previous artifact: unknown
- Summary: Installed the local unsigned capture extension with a stable identity and startup updates across Nightly profiles.

## Deployment 2

- Completed: 2026-10-29T13:52:13.645Z
- Target: local macOS Firefox Nightly, all current-user profiles
- Outcome: Local XPI and all-profile Nightly policies staged; activation pending browser restart.
- Revision boundary: 4ab2cf8c106e9a36dbd68ee1bc5a02c53db218b8..4ab2cf8c106e9a36dbd68ee1bc5a02c53db218b8
- Source: uncommitted working tree based on the to revision; the commit hash alone does not identify this build
- Artifact: Karakeep Local 1.0.2; SHA-256 `2399e415375b25e9ef2a4b4e0b4c3d6b3f5d0b8d436e223f35e4c4c46f3a7bf3`
- Previous artifact: 99a0f0106893cbc7768ce156c5d095a2485d48b4a4ca373e4028a9e64dabc41f
- Summary: Updated the local unsigned capture extension with a stable identity and startup updates across Nightly profiles.

- Validation: real headless Nightly 160.0a1 passed unsigned installation, updates from 1.0.1 to 1.0.2 in two profiles, a new-profile install, and restart persistence. All test processes/profiles were removed; everyday profile activation remains pending restart.

## Deployment 3

- Completed: 2026-10-29T14:01:06.841Z
- Target: local macOS Firefox Nightly, all current-user profiles
- Outcome: Local XPI and all-profile Nightly policies staged; activation pending browser restart.
- Revision boundary: 4ab2cf8c106e9a36dbd68ee1bc5a02c53db218b8..4ab2cf8c106e9a36dbd68ee1bc5a02c53db218b8
- Source: uncommitted working tree based on the to revision; the commit hash alone does not identify this build
- Artifact: Karakeep Local 1.0.3; SHA-256 `33baf4a83e4a5eaacc69e954e30b7e0b5bb3fc37bcab7980c8531522440dee37`
- Previous artifact: 2399e415375b25e9ef2a4b4e0b4c3d6b3f5d0b8d436e223f35e4c4c46f3a7bf3
- Summary: Updated the local unsigned capture extension with a stable identity and startup updates across Nightly profiles.

## Deployment 4

- Completed: 2026-10-29T16:19:02.527Z
- Target: local macOS Firefox Nightly, all current-user profiles
- Outcome: Local XPI and all-profile Nightly policies staged; activation pending browser restart.
- Revision boundary: 4ab2cf8c106e9a36dbd68ee1bc5a02c53db218b8..e9d96904e83cfd5cd9f3b4ec680b5b982cd90065
- Source: uncommitted working tree based on the to revision; the commit hash alone does not identify this build
- Artifact: Karakeep Local 1.0.4; SHA-256 `700a3a08e15507e65386fd5ad7623ccae62fb45119833359f107a2c8bf098a3d`
- Previous artifact: 33baf4a83e4a5eaacc69e954e30b7e0b5bb3fc37bcab7980c8531522440dee37
- Summary: Updated the local unsigned capture extension with a stable identity and startup updates across Nightly profiles.

- Changes: Removed the large save/success strips and added a fresh popup duplicate lookup that opens existing bookmarks without re-saving or recapturing them.
- Validation: 35 extension tests and both production builds passed; headless Firefox verified 14 popup flows across both bundles with synthetic API responses. Everyday Nightly activation awaits its next browser restart.

## Deployment 5

- Completed: 2026-10-29T16:20:25.130480Z
- Target: local macOS Google Chrome, existing unpacked Karakeep extension
- Outcome: Updated the installed unpacked extension files; activation pending next Chrome launch. Chrome was not running at inspection and was not launched or restarted.
- Revision boundary: unknown..e9d96904e83cfd5cd9f3b4ec680b5b982cd90065
- Source: uncommitted working tree based on the to revision; the commit hash alone does not identify this build
- Artifact: Karakeep 1.2.14; installed extension ID `miehlkgogdghmbbmpiphnjjcjmflmmfb`; unpacked content SHA-256 `69c5b26de981dc297c1641ed7dec235d5c70cac2482d57e8c5da480c7364b4e1` (digest of sorted relative paths and per-file SHA-256 hashes)
- Previous artifact: unknown; prior Chrome deployments have not been reconstructed
- Installed path: `apps/browser-extension/dist`, confirmed from Chrome's existing extension registration
- Summary: Updated the popup to remove the large save/success strips and check for existing bookmarks before capture or saving, preserving saved titles and notes.
- Validation: Both production builds, 35 extension tests, and 14 headless Firefox popup flows across both bundles passed; the installed folder digest matches the validated staged bundle.

## Deployment 6

- Completed: 2026-10-30T15:04:19.338517Z
- Target: local macOS Firefox Nightly, all current-user profiles
- Outcome: Failed before building or changing installed files; this session could not read the installation's current.json (EPERM). The existing Nightly package and policies were not modified.
- Revision boundary: unknown..e9d96904e83cfd5cd9f3b4ec680b5b982cd90065 (intended source; no release was installed)
- Source: uncommitted working tree based on the to revision; the commit hash alone does not identify the intended build
- Artifact: none; the installer stopped before packaging
- Previous artifact: unverified in this session; the last recorded package was Karakeep Local 1.0.4 in deployment 4
- Summary: Attempted to stage the Command+Enter save shortcut; updating Nightly requires running the existing installer from a terminal with access to its installation folder.
- Validation: 41 extension tests, typecheck, lint, formatting, both builds, and eight real-keystroke popup checks across both bundles passed using headless Firefox and synthetic API responses.

## Deployment 7

- Completed: unknown; failure observed on 2026-10-30 before deployment 8
- Target: local macOS Google Chrome, existing unpacked Karakeep extension
- Outcome: Partial failed replacement: removing the generated directory stopped at a denied relative directory operation after some files were removed. Deployment 8 immediately restored the complete validated bundle using absolute file paths.
- Revision boundary: e9d96904e83cfd5cd9f3b4ec680b5b982cd90065..e9d96904e83cfd5cd9f3b4ec680b5b982cd90065 (intended source; replacement incomplete)
- Source: uncommitted working tree based on the to revision; the commit hash alone does not identify the intended build
- Artifact: incomplete generated folder; unpacked SHA-256 `42f5aa7b9a51496f69c7ed103e1213c0c478128dd04e1b865d0dbc91f11d1685`
- Previous artifact: unpacked SHA-256 `2dc83623ca913dfb83ea920f457199d9aedd12faf83bbb229727ac6f4a0c77d5`, backed up before replacement
- Fingerprint method: SHA-256 over sorted relative path UTF-8 bytes followed by each file's raw SHA-256 digest
- Summary: The Command+Enter update initially hit a filesystem operation restriction while replacing generated files.

## Deployment 8

- Completed: 2026-10-30T15:05:04.031592Z
- Target: local macOS Google Chrome, existing unpacked Karakeep extension
- Outcome: Updated the installed unpacked files and verified the complete bundle after deployment 7; browser activation was not checked. Reopen the popup, or reload the extension if Chrome still has the old version in memory. The browser was not opened or restarted.
- Revision boundary: unknown..e9d96904e83cfd5cd9f3b4ec680b5b982cd90065; deployment 7 left an incomplete artifact, and the last complete recorded source on this target was e9d96904e83cfd5cd9f3b4ec680b5b982cd90065 in deployment 5
- Source: uncommitted working tree based on the to revision; the commit hash alone does not identify this build
- Artifact: Karakeep 1.2.14; installed extension ID `miehlkgogdghmbbmpiphnjjcjmflmmfb`; unpacked SHA-256 `0734c14e1522bdd1bfaaf20969f6da072011318c31659129d604ad536856389a`
- Previous artifact: incomplete folder SHA-256 `42f5aa7b9a51496f69c7ed103e1213c0c478128dd04e1b865d0dbc91f11d1685` after deployment 7; the prior complete artifact SHA-256 `2dc83623ca913dfb83ea920f457199d9aedd12faf83bbb229727ac6f4a0c77d5` is retained in a temporary backup
- Fingerprint method: SHA-256 over sorted relative path UTF-8 bytes followed by each file's raw SHA-256 digest
- Installed path: `apps/browser-extension/dist`, the previously verified unpacked registration
- Summary: Command+Enter submits from the title or note field using the same save action as the button; Control+Enter also works and note newlines are preserved.
- Validation: 41 extension tests, typecheck, lint with existing warnings, formatting, and both production builds passed. Eight real-keystroke popup checks covered both bundles in headless Firefox 158.0.1 with synthetic API responses; Chrome itself was not launched. Every installed file matches the validated bundle, and the temporary test fixture was excluded.

## Deployment 9

- Completed: 2026-10-30T15:12:29.307Z
- Target: local macOS Firefox Nightly, all current-user profiles
- Outcome: Local XPI and all-profile Nightly policies staged; activation pending browser restart.
- Revision boundary: e9d96904e83cfd5cd9f3b4ec680b5b982cd90065..e9d96904e83cfd5cd9f3b4ec680b5b982cd90065
- Source: uncommitted working tree based on the to revision; the commit hash alone does not identify this build
- Artifact: Karakeep Local 1.0.5; SHA-256 `9f7637ab4dcc428ea7308d680ad86547c3c75a8cf3425845381af0f840c33bed`
- Previous artifact: 700a3a08e15507e65386fd5ad7623ccae62fb45119833359f107a2c8bf098a3d
- Summary: Updated the local unsigned capture extension with a stable identity and startup updates across Nightly profiles.

## Deployment 10

- Completed: 2026-10-31T09:52:36.669Z
- Target: local macOS Firefox Nightly, all current-user profiles
- Outcome: Local XPI and all-profile Nightly policies staged; activation pending browser restart.
- Revision boundary: e9d96904e83cfd5cd9f3b4ec680b5b982cd90065..e9d96904e83cfd5cd9f3b4ec680b5b982cd90065
- Source: uncommitted working tree based on the to revision; the commit hash alone does not identify this build
- Artifact: Karakeep Local 1.0.6; SHA-256 `49d5cfc190f54d4b72787186b63e023d2fc6762762b93c1827b4c8ee84899bd3`
- Previous artifact: 9f7637ab4dcc428ea7308d680ad86547c3c75a8cf3425845381af0f840c33bed
- Summary: Updated the local unsigned capture extension with a stable identity and startup updates across Nightly profiles.

## Deployment 11

- Completed: unknown
- Target: Briq production, Karakeep browser service
- Outcome: Attempt stopped after Docker loaded the candidate. The image-ID check rejected the import before the running container was replaced.
- Revision boundary: unknown..unknown (no new revision deployed)
- Intended source: browser-host build from e9d96904e83cfd5cd9f3b4ec680b5b982cd90065 with an uncommitted Chrome pin change.
- Artifact: Chrome 156.0.8078.79 AMD64 archive SHA-256 `597de71d2e67f9ef071bcd20c75d67b318479ac3f3cd9a8fa43572ae7356669c`.
- Summary: Attempted to install the security update for the crawler browser. The archive checksum passed.

## Deployment 12

- Completed: 2026-11-03T09:52:22Z
- Target: Briq production, Karakeep browser service
- Outcome: Docker Compose recreated only the browser service and reported the replacement healthy.
- Revision boundary: unknown..e9d96904e83cfd5cd9f3b4ec680b5b982cd90065
- Source: uncommitted Chrome pin change on the to revision. The Git hash alone does not identify the deployed build. Earlier Briq deployments have not been reconstructed.
- Artifact: Chrome 156.0.8078.79 AMD64, Docker image `sha256:16c999e675ce93bd5d24ac193911b4ddb4b0c8e18551bdbcc0236b0c34ced50b`.
- Previous artifact: Docker image `sha256:cb0bb7305e8b272dabad781abc4617bcd1090450b8e51a61d8f5bfe48e9eb1d1`, retained as `karakeep-browser:before-156-20261103T095217Z`.
- Summary: Patched Karakeep's production crawler browser with Chrome 156.0.8078.79.
- Validation: Operator-provided rollout output confirms the archive checksum, replacement image identity, container health, and browser version inside the running container.
