# Curated X capture content

The extension's assembled archive marks its version in both places:

```html
<head><meta name="karakeep:content" content="x-capture-v1"></head>
<body><article data-karakeep-capture="x-capture-v1">…</article></body>
```

For an X/Twitter source URL, `parseHtmlSubprocess` recognizes the exact version
and a direct body-child article. It sanitizes that complete article instead of
running Readability's selection heuristics over it. The browser already selected
the author's thread or article; applying link-density pruning again discarded
linked words, example paragraphs and the byline in a real captured article.
The curated path preserves all captured body text, links and embedded images.
Scripts, event handlers, inline styling, stylesheets and interactive controls
are still removed. The marker identifies a content format, not trusted HTML.

Unmarked pages, different marker versions, missing article roots and non-X source
URLs keep the existing extraction behavior. Capture metadata and its 64 KiB limit
are independent of this HTML marker.

The current Rust engine calls this same `parseHtmlSubprocess` helper for its
initial archive parse and any subsequent rendered parse. Precrawled rendering
uses offline `setContent` with scripts disabled and preserves the head/body
markers. Rust then writes the returned article and converts it to plain text;
it does not run another Readability pass. The legacy Node crawler also calls
the helper. No Rust work-protocol or database-schema change is required.

Validation covers complete body preservation, dense links, code prompts,
bylines, images, sanitization, and exact marker/source gating. The actual article
archive was also passed through the parser entry point and compared against its
complete captured text, links and images. The application publication service and
note composition were exercised with both browser-captured thread and article
through the real API. A Rust binary was not started during browser validation.

The installed worker dependencies are DOMPurify 3.4.16, jsdom 24.1.3 and
Readability 0.6.0. The implementation uses DOMPurify's documented server-side
window binding and HTML-only profile; it does not mutate the sanitized result
or use in-place sanitization/hooks. Existing dependency versions are retained.
Reviewed authoritative references:

- [DOMPurify server usage and configuration](https://github.com/cure53/DOMPurify)
- [DOMPurify 3.4.16 release](https://github.com/cure53/DOMPurify/releases/tag/3.4.16)
- [DOMPurify releases](https://github.com/cure53/DOMPurify/releases)
- [jsdom usage](https://github.com/jsdom/jsdom)
