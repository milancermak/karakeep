# Browser extension development

Run these commands from `apps/browser-extension` after installing the workspace
dependencies with `pnpm install` at the repository root.

## Permanent local Nightly install (macOS)

```sh
pnpm update:nightly
```

Run this once to install, and again after future source changes. It typechecks,
builds, increments the local version, and replaces the unsigned package at
`~/Library/Application Support/Karakeep/browser-extension/nightly/karakeep-local.xpi`.
Restart Nightly when convenient to activate it. Existing tabs and browser
processes are left alone. Configure Karakeep once in each profile you use.

The name is **Karakeep Local** and its permanent ID is defined in
`manifest.nightly.json`. Its settings stay separate from the upstream extension
and the development add-on. The installer uses current-user macOS policies in
`org.mozilla.nightly`, so it covers every existing and future Nightly profile.
It locks `xpinstall.signatures.required` to false to permit unsigned extensions.
The regular Firefox application is unaffected.

The `normal_installed` policy permits disabling the add-on. Its local file URL
is checked at startup; a higher package version updates the existing installation
and preserves settings. Ordinary add-on background update checks are disabled
for this identity. Builds use installed workspace dependencies and never submit
code to Mozilla or read the AMO signing credentials. Each real update is recorded
in the repository's `DEPLOYMENTS.md`. The previous XPI is retained alongside the
current package.

Check `about:policies` for active policies and `about:addons` for **Karakeep Local**
after restarting. `current.json` beside the XPI records its version, base commit,
working-tree state and SHA-256. The local source changes are not a server deployment.

## Firefox development

```sh
pnpm dev:firefox
```

This builds into `dist-firefox`, watches the source, and temporarily installs the
extension in regular Firefox. Each successful build triggers one extension reload.
The first run downloads the pinned `web-ext@10.8.0` tool into pnpm's cache.
Close Firefox or press Ctrl+C to stop.

The dedicated profile in `.local/firefox-dev` retains its X login and extension
settings between runs. Sign in to X and configure Karakeep once in that profile.
It runs alongside the everyday browser. On macOS, the default executable is
`/Applications/Firefox.app/Contents/MacOS/firefox`; Firefox Nightly is not selected.
The runner sets `KARAKEEP_EXTENSION_DEV=true`: the installed name is **Karakeep
Dev** and Firefox ID is `dev-x-capture@karakeep.local`. Its synced settings are
separate from the upstream add-on. Production builds retain the existing name
and `addon@karakeep.app` ID.

Override the executable or dedicated profile when needed:

```sh
KARAKEEP_FIREFOX_BINARY=/path/to/firefox KARAKEEP_FIREFOX_PROFILE=/path/to/dev-profile pnpm dev:firefox
```

Use a development profile: `web-ext` changes browser preferences to enable
debugging. Temporary extensions disappear when that Firefox session closes and
are loaded again by the next `pnpm dev:firefox` run.

To build without starting a browser:

```sh
pnpm build:firefox
```

For a manual development install with the separate identity, use
`KARAKEEP_EXTENSION_DEV=true pnpm build:firefox`.

Load `dist-firefox/manifest.json` through
`about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** if you prefer
manual installation. Click **Reload** there after rebuilding.

## Chrome

```sh
pnpm dev
```

Once, enable Developer mode at `chrome://extensions`, choose **Load unpacked**,
and select `dist`. Keep the Vite process running for CRXJS development reload.
On-demand standalone capture scripts run their updated code on the next capture;
existing injected scripts may need their host page reloaded. Use `pnpm build` for
a standalone production build in `dist`.

## Contract and validation

The workspace lockfile pins CRXJS 3.0.0 and Vite 8.3.0. The Firefox runner pins
web-ext 10.8.0 and uses its documented profile, file-watch, and reload options.
It watches a marker outside the build directory, written after Vite's successful
build event, so web-ext does not reload halfway through generated-file writes.
The installed CRXJS declarations remain authoritative for the fork's
`contentScripts.standaloneFiles` option; current public examples use a different
IIFE configuration. No dependency upgrade is required for this workflow.

Validated on 2026-10-29: runner syntax, help output, lint/format checks, and a
Firefox production bundle. The live Firefox collector captured all three supplied
examples. An installed Firefox extension saved the thread with two embedded
images; an installed Chrome extension saved an article with eight embedded images.
These end-to-end saves used the real API on an isolated local server. The headless
web-ext workflow passed: one initial build and temporary installation, stable
idle, then exactly one additional build and Firefox reload after a source-file
touch. Generated output and browser profiles are excluded from watching. Ctrl+C
exited cleanly and left no Firefox process for the test profiles. See
[`docs/x-capture.md`](../../docs/x-capture.md) for capture behavior and validation
limits. Extension reload can interrupt an in-progress capture; test updates
between capture jobs.

Sources checked on 2026-10-29:

- [web-ext commands and profile options](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/)
- [web-ext automatic reload](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/)
- [web-ext 10.8.0 release](https://github.com/mozilla/web-ext/releases/tag/10.8.0)
- [CRXJS content scripts and HMR](https://crxjs.dev/concepts/content/)
- [CRXJS release history](https://github.com/crxjs/chrome-extension-tools/releases)
- [Vite build API](https://vite.dev/guide/api-javascript#build)
- [Chrome extension reload behavior](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#reload)

Permanent regular Firefox installs require a signed XPI. A separate fork ID and an HTTPS
update manifest can provide automatic everyday updates; this development command
does not sign or publish releases.

Local Nightly policy contracts were checked against the installed Nightly
160.0a1 (build 20261020095929). Unlike the ESR-only wording in the public
Preferences page, its bundled policy code permits the signature preference
whenever `MOZ_REQUIRE_SIGNING` is false, including Nightly. Preferences apply
before policy add-on installation. Its file install path checks the XPI version
at every startup even with `updates_disabled=true`.

- [Mozilla unsigned-install support](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
- [macOS policy keys](https://support.mozilla.org/en-US/kb/managing-policies-macos-desktops)
- [ExtensionSettings local installation](https://firefox-admin-docs.mozilla.org/reference/policies/extensionsettings/)
- [Preferences policy](https://firefox-admin-docs.mozilla.org/reference/policies/preferences/)

The Vite/CRXJS and TypeScript versions above remain unchanged. This workflow
supports the local macOS Nightly application; regular Firefox still requires
Mozilla signatures. No automatic reload is attempted in everyday profiles;
use the dedicated development profile for live source reloads.

The local installer was exercised twice through its documented command. Real
headless Nightly profiles installed the unsigned XPI, two existing profiles
upgraded from 1.0.1 to 1.0.2, a fresh profile installed 1.0.2, and the same
profile retained an active permanent install after restart. These checks used
the real macOS policies without automation mode or per-profile signature
overrides. All isolated test browser processes and profiles were removed.
