# Node 26 upgrade — 2026-11-02

Karakeep's development and build toolchain now uses Node 26 LTS. `.nvmrc` selects major 26, the root engine range is `^26.13.0`, and the root and comparison-tool Node type ranges are `^26`. The lockfile resolves those direct type dependencies to 26.6.1.

CI's existing actions/setup-node v4 action reads `.nvmrc`. The production Dockerfile uses `node:26-bookworm-slim`, preserving the Debian Bookworm base of `node:24-slim`. The development image uses `node:26-alpine`; it explicitly installs Corepack because Node 26 no longer bundles it. Existing production/CI Corepack installation steps already install it explicitly.

The package manager remains the repository's existing `pnpm@11.2.1`, which requires Node >=22.13 and accepts Node 26. The machine's pnpm 12.16.1 launcher successfully dispatches to this pinned version. No unrelated application dependencies were upgraded.

## Validation

Validated on macOS arm64 with Node 26.13.0, npm 12.2.1, pnpm 11.2.1, Next.js 16.4.1, Vitest 4.1.11, better-sqlite3 13.0.3, RE2 1.26.1, and Sharp 0.35.5.

- All 2,444 installed package engine declarations accept Node 26.13.0.
- Direct native-module smoke checks passed for SQLite, RE2, and Sharp.
- `pnpm typecheck`: all 23 tasks passed.
- Unit suites excluding Docker-dependent plugins and end-to-end tests: nine suites, 909 tests passed. The web suite was rerun with `TZ=UTC` because its existing date-format test expects UTC; the local Prague timezone produces a one-hour difference.
- `pnpm install --frozen-lockfile --offline --ignore-scripts`: passed.
- Targeted formatter and whitespace checks passed.

The Docker daemon was not running, so container builds and Docker-dependent integration tests could not be exercised. Official tags were checked for both amd64 and arm64 support. Container compatibility remains a validation gap rather than a claimed successful build. These changes were not deployed.

## Sources and contract checks

- [Node 26.13.0 release](https://nodejs.org/en/blog/release/v26.13.0): current LTS release and platform artifacts.
- [Node 26.0.0 release](https://nodejs.org/en/blog/release/v26.0.0): runtime removals and major changes reviewed before changing the pin.
- [Official Node image definitions](https://github.com/docker-library/official-images/blob/master/library/node): 24-slim maps to Bookworm, while 26-slim maps to Trixie; 26-bookworm-slim preserves the operating-system family.
- [pnpm installation and compatibility](https://pnpm.io/installation): package-manager/runtime distinction. The installed pnpm 11.2.1 manifest declares Node >=22.13.
- [actions/setup-node](https://github.com/actions/setup-node): `node-version-file` reads `.nvmrc`; the action revision was retained.
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) and [RE2](https://github.com/uhop/node-re2): supported runtime and native/prebuilt installation requirements. Installed engine metadata and actual native consumers were checked as well.

No external service API, authentication headers, or application protocol was changed by this runtime update.
