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

## Deployment 13

- Completed: 2026-11-03T15:09:21.480Z
- Target: local macOS Firefox Nightly, all current-user profiles
- Outcome: Local XPI and all-profile Nightly policies staged; activation pending browser restart.
- Revision boundary: e9d96904e83cfd5cd9f3b4ec680b5b982cd90065..29ddc665f9854f0b2588b58862c7866620dc973f
- Source: uncommitted working tree based on the to revision; the commit hash alone does not identify this build
- Artifact: Karakeep Local 1.0.7; SHA-256 `8cdce6a86006a660ba700d9298a075059650be16baf086d0d0e73c550b147a8e`
- Previous artifact: 49d5cfc190f54d4b72787186b63e023d2fc6762762b93c1827b4c8ee84899bd3
- Summary: Close the popup after successful Command+Enter or Control+Enter saves and keep it open on errors.
- Validation: XPI checksum and version verified. The packaged popup bundle matches the Chrome build.

## Deployment 14

- Completed: 2026-11-03T15:09:30.800595Z
- Target: local macOS Google Chrome, existing unpacked Karakeep extension
- Outcome: Installed files replaced and verified. Activation awaits a Chrome extension reload or browser restart.
- Revision boundary: e9d96904e83cfd5cd9f3b4ec680b5b982cd90065..29ddc665f9854f0b2588b58862c7866620dc973f
- Source: uncommitted working tree based on the to revision
- Artifact: Karakeep 1.2.14; unpacked SHA-256 `4cc30f5afa79ea497eafc34e528d0db438e2fb162cc6ca9f5ee555d90bc1415a`
- Previous artifact: unpacked SHA-256 `0734c14e1522bdd1bfaaf20969f6da072011318c31659129d604ad536856389a`; prior files retained in the local backup
- Fingerprint method: SHA-256 over sorted relative path UTF-8 bytes followed by each file's raw SHA-256 digest
- Summary: Close the popup after successful Command+Enter or Control+Enter saves and keep it open on errors.
- Validation: 42 extension tests and both builds passed. Installed files match the Chrome build.

## Deployment 15

- Completed: 2026-11-04T14:25:13.492Z
- Target: local macOS Firefox Nightly, all current-user profiles
- Outcome: Local XPI and all-profile Nightly policies staged; activation pending browser restart.
- Revision boundary: 29ddc665f9854f0b2588b58862c7866620dc973f..29ddc665f9854f0b2588b58862c7866620dc973f
- Source: uncommitted working tree based on the to revision; the commit hash alone does not identify this build
- Artifact: Karakeep Local 1.0.8; SHA-256 `061639a10f0a458845a135c379527f1bea48cc34a4f3e1c4011a3641e5e8d70d`
- Previous artifact: 8cdce6a86006a660ba700d9298a075059650be16baf086d0d0e73c550b147a8e
- Summary: Capture the requested X post and rendered replies without scrolling or waiting for the thread to end.
- Validation: XPI checksum and version verified. The packaged collector matches the tested Chrome build.

## Deployment 16

- Completed: 2026-11-04T14:25:34.417912Z
- Target: local macOS Google Chrome, existing unpacked Karakeep extension
- Outcome: Installed files replaced and verified. Activation awaits a Chrome extension reload or browser restart.
- Revision boundary: 29ddc665f9854f0b2588b58862c7866620dc973f..29ddc665f9854f0b2588b58862c7866620dc973f
- Source: uncommitted working tree based on the to revision
- Artifact: Karakeep 1.2.14; unpacked SHA-256 `2d9a90fc834142a186033d076596f9d5638f48fee77f453d82cfa04a6c8f782f`
- Previous artifact: unpacked SHA-256 `4cc30f5afa79ea497eafc34e528d0db438e2fb162cc6ca9f5ee555d90bc1415a`; prior files retained in the local backup
- Fingerprint method: SHA-256 over sorted relative path UTF-8 bytes followed by each file's raw SHA-256 digest
- Summary: Capture the requested X post and rendered replies without scrolling or waiting for the thread to end.
- Validation: 41 extension tests, both builds, and the headless Firefox collector fixture passed. The installed collector matches the tested build.

## Deployment 17

- Completed: 2026-11-05T17:28:48.734Z
- Target: local macOS Firefox Nightly, all current-user profiles
- Outcome: Local XPI and all-profile Nightly policies staged; activation pending browser restart.
- Revision boundary: 29ddc665f9854f0b2588b58862c7866620dc973f..495f22bb3ce3a0535f30e0dd360cc459a20dcf7c
- Source: uncommitted working tree based on the to revision; the commit hash alone does not identify this build
- Artifact: Karakeep Local 1.0.9; SHA-256 `21c714ba301ab33a8b10a2deec10952481c73f0f6a95e8666c4b633e989d4d94`
- Previous artifact: 061639a10f0a458845a135c379527f1bea48cc34a4f3e1c4011a3641e5e8d70d
- Summary: Match X posts via their own permalink, views, or media links and recover a scrolled-out post while preserving rendered replies.
- Validation: XPI checksum and version verified. The packaged collector and background script match the tested Chrome build.

## Deployment 18

- Completed: 2026-11-05T17:29:31.852761Z
- Target: local macOS Google Chrome, existing unpacked Karakeep extension
- Outcome: Installed files replaced and verified. Activation awaits a Chrome extension reload or browser restart.
- Revision boundary: 29ddc665f9854f0b2588b58862c7866620dc973f..495f22bb3ce3a0535f30e0dd360cc459a20dcf7c
- Source: uncommitted working tree based on the to revision
- Artifact: Karakeep 1.2.14; unpacked SHA-256 `2b5c8db0bdbc6c0b82dce0c949e395f1f9f80edfb00c75cc589ccb50a75988e9`
- Previous artifact: unpacked SHA-256 `2d9a90fc834142a186033d076596f9d5638f48fee77f453d82cfa04a6c8f782f`; prior files retained in the local backup
- Fingerprint method: SHA-256 over sorted relative path UTF-8 bytes followed by each file's raw SHA-256 digest
- Summary: Match X posts via their own permalink, views, or media links and recover a scrolled-out post while preserving rendered replies.
- Validation: 47 extension tests, both builds, and the headless Firefox collector fixture passed. The installed files match the tested Chrome build.
