# Personal notes in saved content

The bookmark's `note` remains the editable source of truth. Owner readable
content starts with that note, a separator, and the captured source. Clearing
the note removes the prefix. Owner link reader HTML uses an escaped note section
marked `data-karakeep-owner-note`; source highlights and reading positions exclude
that section so note edits do not move their offsets.

For bookmarks with a nonempty note, the existing `extracted_documents.document`
JSON stores `ownerContent: { version: 1, note, text }`, including the combined
plain text. It is rebuilt on note/source edits, link re-saves, extraction
publication, and lazy extraction backfill. Bookmarks without a note have no
`ownerContent` copy. Link HTML is composed when read rather than stored twice.
Existing records receive the stored projection when edited or processed; this
change does not run a library-wide backfill.

Raw HTML/assets, `extracted_documents.plainText`, editable text-bookmark bodies,
and editable asset content stay clean. The normal source-edit fields therefore
cannot feed a generated note prefix back into saved source. Owner
`getBookmarkReadableContent` returns combined text/Markdown for every bookmark
type; `getBookmark` includes the note in link `htmlContent` when content is
requested. Collaborators and public responses continue receiving clean source,
without the owner's personal note.

Search and embeddings already include `note` independently, so their source text
remains unprefixed. The Rust work protocol stays at version 1: the application
stores the private combined projection when applying the engine's clean document
result. No Rust protocol or database schema migration is required. The legacy
crawler and asset extraction paths refresh the same projection.
