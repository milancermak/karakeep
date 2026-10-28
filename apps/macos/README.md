# Karakeep Capture for macOS

A native menu bar capture client for this fork’s `milan` branch. Requires macOS
14 or newer. The Swift package has no third-party dependencies.

## Build and open

With Xcode 16 or newer selected as the command-line toolchain:

```sh
cd apps/macos
./scripts/build.sh
open "build/Karakeep Capture.app"
```

The build produces an ad-hoc signed app for the current Mac’s architecture. Move
the app to Applications if desired. Set `CODESIGN_IDENTITY` to use a configured
signing identity. Distribution signing and notarization are separate release
steps; the local build does not perform either.

The app enables Launch at login on its first launch. The switch in Settings
reflects macOS’s current registration and can turn it off again. If macOS needs
approval, use Allow in System Settings. A later choice to disable startup is
respected. The app stays in the menu bar when started at login.

In Settings, enter the server’s HTTPS URL and a Karakeep API key. Create a key in
the server’s Settings → API Keys with `bookmarks:readwrite`, `assets:readwrite`,
and `users:read` permissions. Legacy full-access keys also work. The key is kept
in macOS Keychain. The account is verified with `/api/v1/users/me` when connecting.
HTTP is accepted only for localhost development. Use the server’s final URL;
authenticated requests do not follow redirects.

## Capture

- Click the menu bar Karakeep icon, type, attach files, and press Save.
- Drop one or more files onto the icon to open the same composer with those files.
- Files and images can also be dropped or pasted into the editor. Clipboard
  images are attached as PNG files.
- Return and Shift+Return insert newlines. Command+Return saves. Escape closes
  the popover and retains the draft.
- Switch to Recent for saves from this installation, newest first. Select a
  saved note to open it in Karakeep. History is separated by server and account.
- Right-click or Control-click the icon for New Note, Recent Notes, Upload Last
  Screenshot, Settings, and Quit. Settings opens a separate floating window.
- Upload Last Screenshot attaches the newest image or PDF in the selected
  screenshot folder. It opens the composer for optional text and explicit Save.
  The default folder uses macOS’s configured screenshot location, or Desktop.

Each capture creates one text bookmark with its files attached as `userUploaded`
assets. File-only captures use the filenames as the bookmark’s text. Existing
images and PDFs continue to work with the standard API. **General files require
the server changes included with this client**: unsupported formats are uploaded
as `application/octet-stream` and downloaded with `Content-Disposition:
attachment`. The server’s existing size, quota, and rate limits still apply. No
database migration is needed. Building the app does not deploy the server.

## Local data and recovery

Drafts, staged attachment copies, connection settings, and the app’s save history
are stored in `~/Library/Application Support/Karakeep Capture`. The API key is
stored separately in Keychain. Attachment copies let a draft survive the source
file moving or disappearing. Successful saves remove the staged copies. Closing
the popover or quitting preserves an unfinished draft.

A save interrupted after the bookmark is confirmed resumes that bookmark and
reuses confirmed uploads. A partial server note remains if the local draft is
discarded. If the initial create request times out without confirmation, check
Karakeep before retrying: the API has no idempotency key for text creation.

Recent is a local record of completed saves. It does not include other clients,
other installations, or partially saved notes, and is not synchronized with edits
or deletions made on the server.

For an isolated development profile, launch the executable with
`KARAKEEP_CAPTURE_DATA_DIR` pointing to a separate directory. This changes local
draft/history storage; Keychain credentials remain associated with the server URL.

## Verification

```sh
cd apps/macos
swift test
```

The tests cover HTTP authentication and payloads, errors, draft recovery, staged
file bytes, attachment retry behavior, account isolation, chronological history,
screenshot selection, and AppKit keyboard handling.

An optional integration test exercises the native client against a running local
Karakeep server. It creates and removes its own synthetic note and attachments.
Supply a disposable account’s API key in a private file:

```sh
KARAKEEP_CAPTURE_TEST_SERVER=http://localhost:3100 \
KARAKEEP_CAPTURE_TEST_KEY_FILE=/path/to/private-test-key \
swift test --filter LiveServerTests
```

See [HANDOFF.md](HANDOFF.md) for verified versions, contract sources, and results.
