# Automatic short titles

The fork's Rust engine generates a title when a saved item's main `title` is
missing, empty, or whitespace. A nonblank supplied title is preserved. A model
response arriving after a manual title or content edit is rejected using the
existing job fingerprint and a conditional database write.

Generation uses OpenAI `gpt-6.1-terra`, independently of the tagging and summary
models and preferences. It uses the existing Chat Completions endpoint and
restricted OpenAI key; no additional endpoint permission is required. The task
requests no reasoning, caps output at 128 tokens, and requests 3–7 words. The
application enforces a 60-character limit without splitting Unicode characters.

Text notes can be titled immediately. Links wait for extraction; image/PDF
bookmarks run through the existing extraction/OCR pipeline first. Images can
also be supplied to Terra. The user's annotation and descriptive client
metadata provide context alongside the saved content. A failed crawl can still
use a meaningful annotation, while empty material is skipped.

Saving remains asynchronous. Generated titles go into the existing `title`
field, so the UI, REST API, mobile apps, MCP and JSON export use them without a
new client contract. Source page titles and client metadata remain separate.
Title work takes priority over initial embeddings. Pending embeddings use the
new title; a title arriving later refreshes search and embeddings. Completed
tagging and extraction are preserved, and unfinished tagging continues with
the current content.

Clearing a title requests another generation. Other edits preserve any existing
nonblank title, including a previously generated one. Existing untitled items
are eligible when edited or reprocessed; startup does not backfill the library.
Generation failures use the engine's bounded retries and leave the saved item
available with its normal display fallback. They do not change tagging or
summarization statuses. An empty model title is ignored.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `INFERENCE_ENABLE_AUTO_TITLES` | `true` | Enable missing-title generation in the Rust runtime. |
| `INFERENCE_TITLE_MODEL` | `gpt-6.1-terra` | Model used specifically for titles. |

Title jobs reuse the engine's existing AI capacity, leases, checkpoints and
publication transaction. No new resident worker or queue is introduced. This
feature targets the fork's Rust runtime; the historical Node worker does not
generate titles.

Model compatibility: [official OpenAI Terra documentation](https://developers.openai.com/api/docs/models/gpt-6.1-terra).
