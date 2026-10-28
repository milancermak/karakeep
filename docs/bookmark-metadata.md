# Bookmark metadata in this fork

Every saved link, text note and uploaded asset has a `metadata` JSON object in
the main bookmark row. Existing items default to `{}`. This is writable client
context, separate from the user's `title` and `note`, the crawler's link fields,
the extracted-document artifact, and generated OCR/PDF asset metadata. Crawling
and extraction preserve it. Like personal notes, it is visible to the owner;
collaborator responses return `{}` and public-list responses omit it.

## Client API

Use the existing authenticated `POST /api/v1/bookmarks` and
`PATCH /api/v1/bookmarks/{bookmarkId}` endpoints. The same field is available in
tRPC, the generated SDK, JSON exports/backups and import staging. Old clients
can omit it. Reading/listing/searching a bookmark returns its metadata.

For example, an extension can save the page title without setting the user's
title:

```json
{
  "type": "link",
  "url": "https://example.com/post",
  "note": "Another agent hosting runtime",
  "metadata": {
    "capture": {
      "pageTitle": "Original browser document title",
      "method": "firefox-extension"
    },
    "search": {
      "text": "Agent compute, VPS and hosting"
    }
  }
}
```

Writes use JSON Merge Patch semantics for `metadata`:

- Omit the field to preserve it, including when re-saving an existing link.
- Objects merge recursively; independent clients can patch their own keys.
- Arrays replace the existing array. They are not appended or deduplicated.
- A property set to `null` removes that key. `metadata: null` clears everything.
- `metadata: {}` preserves the existing object.

The merged object is limited to 64 KiB of UTF-8 JSON and 16 levels of nesting.
Only JSON values are accepted; reserved prototype keys are rejected. Store
large thread text, screenshots and other documents in content/assets rather
than treating metadata as an unbounded attachment store. New metadata merges
with the current row inside the write transaction, preserving disjoint updates
from concurrent clients. For the same key, the last committed patch wins.

New `create-bookmark` MCP calls accept `note` and `metadata`; `update-bookmark`
accepts metadata patches and clearing. Bookmark retrieval and search results
include the JSON. MacBook development sessions should pull this branch and
rebuild the MCP package with `pnpm --filter @karakeep/mcp build` when using these
tool inputs. Existing installed upstream MCP builds do not expose them.

## Search projection

Keyword search and embedding inputs include string values (or arrays of strings)
at these descriptive paths:

- `pageTitle`, `title`, `description`, `author`
- `capture.pageTitle`
- `source.title`, `source.description`, `source.author`
- `company.name`, `company.description`
- `search.text`, `search.keywords`

Other keys are retained and readable by clients/agents but are not indexed.
Use `search.text` or `search.keywords` to opt additional descriptions into
retrieval. IDs, timestamps, capture status and arbitrary technical values should
remain outside that projection. Metadata-specific filter operators are not
implemented. Semantic/hybrid retrieval uses the existing embedding provider;
metadata alone does not guarantee exhaustive answers to natural-language queries.

Descriptive metadata and personal-note/title/summary edits refresh embeddings
and keyword search. Operational-only metadata changes do not request a new
embedding. These edits do not request a fresh crawl, OCR or AI tagging pass.
The Rust engine receives the projected text through its existing prepared-work
contract; it does not own or rewrite the client JSON.

## Firefox capture follow-up

Firefox is the primary browser for the capture prototype. An extension can use
`browser.tabs.create({ url, active: false })` to load a separate inactive tab;
`tabs.hide()` is an optional refinement requiring `tabHide`. When Containers
are in use, preserve the source tab's `cookieStoreId` (requires `cookies`
permission) to use the intended logged-in session. Persist capture jobs and
progress because Firefox's Manifest V3 background pages are nonpersistent.

Inactive/hidden-tab support does not prove that X will load an entire thread or
all replies without activation. Test DOM loading, scrolling, visibility checks,
reply limits and login challenges on Firefox before promising completeness.
Do not mark a partial capture complete. No paid X API is required by the design;
the X capture implementation and extension/UI title changes are follow-up work.

References: [inactive tabs](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/create),
[hidden tabs](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/hide),
[background lifecycle](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts).
