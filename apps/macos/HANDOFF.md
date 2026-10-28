# macOS capture client handoff

Implementation is on `milan`, based on
`bb1b2d3dc0a14f6cdd07787520f085f6f518863b`.

## Versions and contracts

Validated with Apple Swift 6.2.4, Swift language mode 6, Xcode 26.3 / macOS 26.2
SDK, running on macOS 15.7.4 (Apple Silicon). The deployment target is macOS 14.
The client uses Foundation URLSession, AppKit, SwiftUI, and Security/Keychain;
there are no external Swift packages. macOS 14 and Intel have not been run.

Login startup uses the system ServiceManagement framework’s `SMAppService.mainApp`
(available since macOS 13), checked against the installed macOS 26.2 SDK headers
and Apple’s current [registration documentation](https://developer.apple.com/documentation/servicemanagement/smappservice/register()).
The first launch registers the signed main app once. Settings reads the actual
system status, supports unregistering, and offers System Settings for approval
when required. It refreshes on app activation and respects later disabling.
No helper executable, launch agent, or external library was added.

Settings inputs use native AppKit text and secure controls with left alignment,
inside labeled SwiftUI form rows. The grouped form overrides alignment on the
standard SwiftUI fields; the native controls avoid that behavior. A regression
check hosts the real controls in a grouped form and verifies both alignment and
the insertion point's position, in light and dark appearances. A rendered check
also confirmed URL text and secure bullets at the left edge.

The menu bar image is a template PDF generated from the repository’s official
`logo-icon.svg` glyph contours. The original filled square is transparent and
the glyph is solid; macOS applies the appropriate menu bar color.
The rebuilt app was restarted on the target Mac and reported Launch at login as
enabled through the actual ServiceManagement status. No logout or reboot was
performed to test a new login session.

The checkout’s Karakeep SDK/application release metadata is 0.34.0. This client
does not link the TypeScript SDK. It speaks the existing REST `/api/v1` protocol.
The checked-in specification is OpenAPI 3.0.0 with API info version 1.0.0.
The current upstream documentation selects Karakeep 0.34.0. Upstream 0.34.1’s
release notes describe a Node security update and do not change these endpoints.
No existing dependencies were upgraded.

Authoritative sources reviewed before implementation:

- [Karakeep create bookmark](https://docs.karakeep.com/api/create-bookmark/)
- [Karakeep upload asset](https://docs.karakeep.com/api/upload-asset/)
- [Karakeep releases](https://github.com/karakeep-app/karakeep/releases)
- [Apple NSStatusItem](https://developer.apple.com/documentation/appkit/nsstatusitem)
- [Apple drag destinations](https://developer.apple.com/documentation/appkit/nsdraggingdestination)
- [Apple Keychain services](https://developer.apple.com/documentation/security/keychain-services)
- The installed AppKit SDK headers, `packages/open-api/karakeep-openapi-spec.json`,
  `packages/api/routes/{assets,bookmarks,users}.ts`,
  `packages/api/utils/{upload,assets}.ts`, and the shared bookmark/asset schemas.

The affected contract is:

| Operation | Contract |
| --- | --- |
| Connect | GET `/users/me`, Bearer API key; decode stable user ID and nullable name/email |
| Create | POST `/bookmarks`, JSON `{type:"text",text,source:"api"}`; accept 200/201; retain returned ID |
| Resume text | PATCH `/bookmarks/{id}`, JSON `{text}` |
| Upload | POST `/assets`, multipart field `file`, original filename and MIME; retain returned `assetId` |
| Attach | POST `/bookmarks/{id}/assets`, JSON `{id,assetType:"userUploaded"}` |
| Open note | Server’s `/dashboard/preview/{id}` in the default browser |

Every API request supplies Authorization and Accept headers. JSON requests also
supply Content-Type. The session is ephemeral, does not store cookies, preserves
the configured base path, retains normal TLS validation, and refuses redirects.
HTTP failures including authentication, permissions/quota, size, rate limiting,
and server errors retain the draft. No automatic mutation retries occur.

Files outside the upstream upload allowlist explicitly use binary MIME. This
fork normalizes unsupported detected types to `application/octet-stream` for
those uploads, permits their storage in both asset-store implementations through
the shared MIME set, and serves them as downloads with sanitized filenames.
Supported image/PDF types retain detection; spoofed image MIME remains rejected.
Standard bookmark creation types and source enums are unchanged. OpenAPI prose
and the generated specification describe the binary attachment behavior.

## Validation

- Native debug and release builds; an ad-hoc signed `.app` bundle.
- Swift tests for draft/file persistence, one-note/multiple-attachment saves,
  resumed partial saves, account/history isolation, ordering, screenshot
  selection, HTTP payloads/status failures, nullable identity fields, malformed
  responses, and AppKit Return/Shift+Return/Command+Return handling.
- Seven server tests for actual upload processing and streamed download responses:
  generic files, unsupported detected formats, image detection, MIME spoofing,
  size limits, download headers, and preserved inline images.
- API/shared type checks; API/shared/OpenAPI lint and formatting; generated
  OpenAPI consistency; Swift formatting and whitespace checks.
- Native runtime inspection: settings launches as a separate floating window;
  the composer opens with text focus; Return and Shift+Return preserve multiline
  text; Command+Return and Save without a connection open Settings;
  closing/reopening preserves the draft. The synthetic UI draft was cleared.

- All 13 Swift tests passed with the live test enabled. The actual native
  `APIClient`/`CaptureService` saved a multiline Unicode note plus a PNG and a
  plain-text attachment against a separate, seeded local Karakeep instance.
  The test fetched the note, checked both attachments’ exact downloaded bytes,
  checked the generic-file download header, and removed the synthetic bookmark.
- The live response passed Ajv 8 validation against the checked-in OpenAPI
  `Bookmark` schema, with `ajv-formats` validating date/URI formats.
- All 15 API package tests passed, including the seven added upload/download
  tests. The temporary scoped local API key was revoked after the test; its
  rejection was verified with a 401 response and the local secret files removed.

Finder-to-menu-bar drag delivery and completed file-picker selection still need
a manual check on the target Mac. The destination and attachment staging are
implemented; the live integration exercises attachment upload and download.
The computer-use service timed out while inspecting the system menu bar. The
final release bundle was rebuilt and its signature verified afterward.

## Release boundaries

No production deployment has been performed. General-file support requires
deploying the included server change. Images/PDFs use the existing upload
contract. The local app bundle is ad-hoc signed; it is not notarized or packaged
for distribution. Startup registration is managed by macOS, subject to its
approval and code-signing requirements.
