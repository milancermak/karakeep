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
