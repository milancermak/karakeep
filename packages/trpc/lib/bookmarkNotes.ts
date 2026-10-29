import { eq } from "drizzle-orm";

import type { DB } from "@karakeep/db";
import { bookmarks, extractedDocuments } from "@karakeep/db/schema";
import { escapeHtml, htmlToPlainText } from "@karakeep/shared/utils/htmlUtils";
import { readAsset } from "@karakeep/shared-server";
import { digest } from "@karakeep/shared-server/work/ledger";

export function bookmarkSourceFingerprint(bookmark: {
  type: string;
  link?: { url: string } | null;
  text?: { text: string | null } | null;
  asset?: { assetId: string } | null;
}) {
  return digest({
    type: bookmark.type,
    url: bookmark.link?.url,
    text: bookmark.text?.text,
    assetId: bookmark.asset?.assetId,
  });
}

export function prependBookmarkNote(content: string, note?: string | null) {
  return note?.trim() ? `${note.trim()}\n\n---\n\n${content}` : content;
}

export function prependBookmarkNoteHtml(content: string, note?: string | null) {
  if (!note?.trim()) return content;
  const paragraphs = note
    .trim()
    .split(/\n\s*\n/)
    .map(
      (paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
  return `<section data-karakeep-owner-note>${paragraphs}</section><hr data-karakeep-owner-note>${content}`;
}

export function ownerContent(note: string | null | undefined, text: string) {
  return note?.trim()
    ? { version: 1, note: note.trim(), text: prependBookmarkNote(text, note) }
    : undefined;
}

export async function refreshBookmarkOwnerContent(
  db: DB,
  bookmarkId: string,
  sourceText?: string,
) {
  const bookmark = db.query.bookmarks
    .findFirst({
      where: eq(bookmarks.id, bookmarkId),
      with: { link: true, text: true, asset: true },
    })
    .sync();
  if (!bookmark) return;
  const extracted = db
    .select()
    .from(extractedDocuments)
    .where(eq(extractedDocuments.bookmarkId, bookmarkId))
    .get();
  if (!bookmark.note?.trim()) {
    if (extracted) {
      const document = JSON.parse(extracted.document) as Record<
        string,
        unknown
      >;
      if (document.ownerContent !== undefined) {
        delete document.ownerContent;
        db.update(extractedDocuments)
          .set({ document: JSON.stringify(document) })
          .where(eq(extractedDocuments.bookmarkId, bookmarkId))
          .run();
      }
    }
    return;
  }

  const fingerprint = bookmarkSourceFingerprint(bookmark);
  let text = sourceText ?? bookmark.text?.text ?? bookmark.asset?.content;
  if (text == null && extracted?.fingerprint === fingerprint) {
    text = extracted.plainText;
  }
  if (text == null && bookmark.link) {
    const html = bookmark.link.contentAssetId
      ? (
          await readAsset({
            userId: bookmark.userId,
            assetId: bookmark.link.contentAssetId,
          })
        ).asset.toString("utf8")
      : bookmark.link.htmlContent;
    text = htmlToPlainText(html ?? "");
  }
  text ??= "";
  const document =
    extracted?.fingerprint === fingerprint
      ? (JSON.parse(extracted.document) as Record<string, unknown>)
      : {
          version: 1,
          parser: "existing",
          sourceUrl:
            bookmark.link?.url ??
            bookmark.text?.sourceUrl ??
            bookmark.asset?.sourceUrl,
          htmlAssetId: bookmark.link?.contentAssetId,
        };
  document.ownerContent = ownerContent(bookmark.note, text);
  const values = {
    bookmarkId,
    fingerprint,
    document: JSON.stringify(document),
    plainText: text,
    extractedAt: extracted?.extractedAt ?? Date.now(),
  };
  db.insert(extractedDocuments)
    .values(values)
    .onConflictDoUpdate({ target: extractedDocuments.bookmarkId, set: values })
    .run();
}
