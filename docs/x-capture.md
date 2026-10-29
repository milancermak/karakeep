# X and Twitter capture

Saving an HTTPS `x.com` or `twitter.com` status or article through the extension's
toolbar, shortcut, or link context menu invokes the browser collector. It uses
the signed-in browser session and rendered DOM; no paid X API is involved.

The current implementation runs in the foreground with a capture dialog. It
scrolls the page, expands long post text, collects the original author's connected
thread in order, and excludes other authors' replies and quoted-post content.
Article saves preserve the full rendered article body and use its full heading
as the bookmark title unless the user edits the title. A context-menu target
opens in an active tab when the current tab is a different post. The original
scroll position is restored when collection ends. Cancel or Escape stops
collection; errors leave the save available for retry.

The archive contains source content and bylines, without the owner's note.
The server composes personal notes into owner-readable content separately; see
[`notes-content.md`](notes-content.md). The assembled HTML uses the versioned
curated-content contract in
[`browser-capture-content.md`](browser-capture-content.md), preserving captured
body text, dense links, and images through server extraction while sanitizing
HTML. Re-saving an existing link replaces its captured archive and requests
processing of the new content.

## Metadata and media

The bookmark's normal content/archive stores the body. Its metadata records:

| Path | Value |
| --- | --- |
| `capture.method` | `x-dom` |
| `capture.pageTitle` | Capture title |
| `capture.capturedAt` | UTC capture timestamp |
| `capture.status` | `complete` for saved captures |
| `capture.imagesEmbedded`, `capture.imagesFailed` | Image archival counts |
| `capture.metadataTruncated` | Present when metadata lists were shortened |
| `source.author`, `source.url` | Original author and canonical requested URL |
| `x.kind` | `post`, `thread`, or `article` |
| `x.requestedPostId` | Requested status/article ID |
| `x.posts` | Captured post IDs and permalinks |
| `x.links` | Body/card links with `url` and `sourcePostId` |
| `x.images` | Embedded-image URLs, alt text, and `sourcePostId` |

Body links include links to X content, GitHub, YouTube, and other destinations.
Expanded URLs exposed by the DOM are used first. Unresolved `t.co` links are
opened in disposable inactive tabs to inspect their redirect destination; a
resolved entry keeps the original URL in `shortUrl`. Those tabs are closed after
inspection. Unresolved destinations retain the original short URL. Links are
deduplicated by destination URL.

When image capture is enabled in extension settings, supported images from
`pbs.twimg.com` are embedded into the HTML archive. Failed images retain their
source URLs in content/metadata, and their count is recorded. Video files and
the contents of linked GitHub/YouTube pages are not archived by this collector.
The metadata contract and search projection are documented in
[`bookmark-metadata.md`](bookmark-metadata.md).

## Limits

Collection has a 60-second deadline and a 500-post ceiling. It stops when X
exposes a stable article or an apparent thread boundary. If X does not reveal
enough content to establish completion, the extension rejects the partial capture
and shows an error. Login challenges, unavailable posts, hidden continuations,
and X DOM changes can still require a reload or implementation update.

Short-link resolution has a 15-second total budget and at most five seconds per
link. Images have a 15-second request timeout, a 10 MiB per-image limit, and a
25 MiB combined embedding limit. Image embedding is best effort.

Metadata is trimmed below 60,000 UTF-8 bytes to leave room under the server's
64 KiB limit; images, links, then post references are shortened if needed and
`metadataTruncated` is set. The complete captured body remains in the archive.
Existing unrelated bookmark metadata is preserved by the server's merge rules.

## Development and validation

[`apps/browser-extension/README.md`](../apps/browser-extension/README.md) describes
the Firefox build watcher and Chrome development reload. Development Firefox
builds use **Karakeep Dev**, ID `dev-x-capture@karakeep.local`, in a separate
profile; production identity remains unchanged.

On 2026-10-29, the live Firefox collector captured all three supplied examples:
the Shadaj thread and the PostHog and Thorsten Ball articles. The installed Firefox
extension saved the thread with two embedded images. The installed Chrome
extension saved an article with eight embedded images. These saves exercised the
real bookmark/assets API on an isolated local server; production was not changed.
The final curated article archive also passed the parser entry point and
application publication service checks described in the curated-content contract.
The final installed Chrome recapture also passed: the article heading was
automatically extracted as the title, all 10,206 normalized captured text
characters survived publication, and 33 metadata links and eight embedded images
were retained. Reloading the extension and recapturing the existing X page worked
without reloading that page.

The development runner's syntax, help output, lint/format checks, and Firefox
bundle passed. The actual headless web-ext workflow produced one initial build
and temporary installation, stayed idle, then produced exactly one additional
build and Firefox reload after a source-file touch. Generated output and browser
profiles are excluded from watching. Ctrl+C exited successfully and left no
Firefox process for the test profiles. Browser validation does not guarantee
that every X conversation exposes all its continuations.

The lockfile retains CRXJS 3.0.0, Vite 8.3.0, and the existing SuperJSON dependency.
The Firefox runner pins web-ext 10.8.0. SuperJSON preserves bookmark dates across
the Chrome JSON-message boundary and Firefox structured-clone boundary. Current
official contracts and release notes were reviewed without upgrading unrelated
dependencies:

- [Chrome message passing and serialization](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#serialization)
- [Firefox message passing](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/sendMessage)
- [Chrome tab creation](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [Firefox script injection](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript)
- [web-ext command reference](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/)
- [web-ext 10.8.0 release](https://github.com/mozilla/web-ext/releases/tag/10.8.0)
- [CRXJS content scripts](https://crxjs.dev/concepts/content/)
- [CRXJS releases](https://github.com/crxjs/chrome-extension-tools/releases)
- [Vite JavaScript build API](https://vite.dev/guide/api-javascript#build)
- [Rolldown watcher exclusions](https://rolldown.rs/reference/InputOptions.watch#exclude)
