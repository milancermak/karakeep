import { readFile, rm, stat } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@karakeep/db";
import {
  assets,
  AssetTypes,
  bookmarkAssets,
  bookmarkLinks,
  bookmarks,
  extractedDocuments,
} from "@karakeep/db/schema";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import { silentDeleteAsset } from "@karakeep/shared-server";
import type { WorkJob } from "@karakeep/shared-server/work/ledger";
import type { WorkResult } from "@karakeep/shared-server/work/contracts";
import { workLedger } from "@karakeep/shared-server/work/runtime";
import config from "@karakeep/shared/config";
import {
  hasBookmarkTitle,
  normalizeGeneratedTitle,
} from "@karakeep/shared/titles";
import { checkedPath, publishArtifacts } from "./assets";
import type { PublishedAsset } from "./assets";
import {
  enqueuePipeline,
  fingerprint,
  queueInitial,
  queueTitle,
  queueRules,
  queueWebhook,
  snapshot,
  sourceFingerprint,
  updateImportProgress,
} from "./model";
import { applyFeed, runDomainOperation } from "./operations";
import { stagingRoot } from "./prepare";
import { ownerContent } from "../../lib/bookmarkNotes";

function attachTags(bookmarkId: string, userId: string, names: string[]) {
  if (names.length === 0) return;
  const ledger = workLedger(),
    sql = ledger.sqlite;
  const normalize = (s: string) => s.toLowerCase().replace(/[ \-_]/g, "");
  const old = sql
    .prepare(
      "SELECT tagId FROM tagsOnBookmarks WHERE bookmarkId=? AND attachedBy='ai'",
    )
    .all(bookmarkId) as { tagId: string }[];
  sql
    .prepare(
      "DELETE FROM tagsOnBookmarks WHERE bookmarkId=? AND attachedBy='ai'",
    )
    .run(bookmarkId);
  const all = sql
    .prepare("SELECT id,name FROM bookmarkTags WHERE userId=?")
    .all(userId) as { id: string; name: string }[];
  const attached: string[] = [];
  for (const name of new Set(
    names.map((n) => n.replace(/^#/, "").trim()).filter(Boolean),
  )) {
    let tag = all.find((t) => normalize(t.name) === normalize(name));
    if (!tag) {
      tag = { id: randomUUID(), name };
      sql
        .prepare(
          "INSERT INTO bookmarkTags(id,name,userId,createdAt) VALUES (?,?,?,unixepoch())",
        )
        .run(tag.id, name, userId);
      all.push(tag);
    }
    const inserted = sql
      .prepare(
        "INSERT INTO tagsOnBookmarks(bookmarkId,tagId,attachedBy,attachedAt) VALUES (?,?,'ai',unixepoch()) ON CONFLICT DO NOTHING",
      )
      .run(bookmarkId, tag.id);
    if (inserted.changes) attached.push(tag.id);
  }
  queueRules(bookmarkId, userId, [
    ...old.map((t) => ({ type: "tagRemoved", tagId: t.tagId })),
    ...attached.map((tagId) => ({ type: "tagAdded", tagId })),
  ]);
}

function date(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function completeJob(
  job: WorkJob,
  result: WorkResult,
): Promise<boolean> {
  const ledger = workLedger(),
    data = JSON.parse(job.payload) as Record<string, unknown>;
  const get = () =>
    typeof data.bookmarkId === "string" ? snapshot(data.bookmarkId) : undefined;
  let b = await get();
  if (!ledger.active(job.id, job.token!)) return false;
  if (
    data.expectedFingerprint &&
    (!b || fingerprint(b) !== data.expectedFingerprint)
  ) {
    return ledger.sqlite
      .transaction(() => {
        if (!ledger.finish(job.id, job.token!, "obsolete")) return false;
        // A generated title can invalidate an older embed -> tag continuation.
        // Keep initial tagging moving, without duplicating a current successor.
        if (
          b &&
          job.kind === "ai" &&
          data.type === "tag" &&
          b.taggingStatus === "pending"
        ) {
          const successor = ledger.sqlite
            .prepare(`SELECT 1 FROM work_jobs
          WHERE subject=? AND state='pending' AND (
            (kind='ai' AND json_extract(payload,'$.type')='tag'
              AND (json_extract(payload,'$.expectedFingerprint') IS NULL
                OR json_extract(payload,'$.expectedFingerprint')=?))
            OR (kind='embedding' AND json_extract(payload,'$.type')='embed'
              AND coalesce(json_extract(payload,'$.runTaggingOnComplete'),1)=1)
          ) LIMIT 1`)
            .get(b.id, fingerprint(b));
          if (!successor)
            ledger.enqueue("ai", { bookmarkId: b.id, type: "tag" });
        }
        return true;
      })
      .immediate();
  }
  if (job.fingerprint && (!b || fingerprint(b) !== job.fingerprint)) {
    ledger.sqlite
      .transaction(() => {
        ledger.finish(job.id, job.token!, "obsolete");
        if (b) {
          if (job.kind === "ingest" || job.kind === "asset") queueInitial(b);
          else if (job.kind === "ai" || job.kind === "embedding")
            ledger.enqueue(job.kind, {
              ...data,
              expectedFingerprint: undefined,
              embedding: undefined,
            });
          else ledger.enqueue("publish", { bookmarkId: b.id, type: "index" });
        } else if (data.bookmarkId) {
          ledger.enqueue("publish", {
            bookmarkId: data.bookmarkId,
            type: "delete",
          });
          ledger.enqueue("embedding", {
            bookmarkId: data.bookmarkId,
            type: "delete",
          });
        }
      })
      .immediate();
    return true;
  }
  if (result.kind === "feed") await applyFeed(job, result);
  if (["rules", "import", "maintenance"].includes(job.kind))
    await runDomainOperation(job);
  let published: PublishedAsset[] = [];
  let text = "";
  const userId =
    b?.userId ?? (typeof data.userId === "string" ? data.userId : undefined);
  if (result.kind === "document") {
    if (!b) return ledger.finish(job.id, job.token!, "obsolete");
    const textPath = await checkedPath(job, result.plainTextPath);
    if ((await stat(textPath)).size > 16 * 1024 * 1024)
      throw new Error("Extracted text exceeds limit");
    text = await readFile(textPath, "utf8");
    published = await publishArtifacts(job, b.userId, result.artifacts);
  } else if (result.kind === "artifacts" && userId)
    published = await publishArtifacts(job, userId, result.artifacts);
  b = await get();
  // Publication involved filesystem IO. Check ownership of the lease and input
  // again immediately before the synchronous domain transaction.
  if (!ledger.active(job.id, job.token!)) return false;
  if (job.fingerprint && (!b || fingerprint(b) !== job.fingerprint)) {
    ledger.finish(job.id, job.token!, "obsolete");
    if (b) queueInitial(b);
    return true;
  }
  const oldAssets: string[] = [];
  ledger.sqlite
    .transaction(() => {
      if (!ledger.active(job.id, job.token!)) throw new Error("Lease lost");
      ledger.sqlite
        .prepare(
          "UPDATE work_settings SET value='1' WHERE key='applying_result'",
        )
        .run();
      for (const asset of published) {
        const assetType =
          asset.role === "linkRawHtml"
            ? AssetTypes.USER_UPLOADED
            : (asset.role as AssetTypes);
        const replaced =
          b?.assets.filter(
            (a) =>
              a.assetType === assetType &&
              a.id !== asset.id &&
              (asset.role !== "linkRawHtml" || a.id.endsWith("-linkRawHtml")),
          ) ?? [];
        oldAssets.push(...replaced.map((a) => a.id));
        for (const old of replaced)
          db.delete(assets).where(eq(assets.id, old.id)).run();
        db.insert(assets)
          .values({
            id: asset.id,
            userId: userId!,
            bookmarkId: b?.id ?? null,
            assetType,
            size: asset.size,
            contentType: asset.contentType,
            fileName: asset.fileName,
          })
          .onConflictDoNothing()
          .run();
      }
      if (result.kind === "document" && b) {
        const m = result.metadata;
        const str = (v: unknown) => (typeof v === "string" ? v : null);
        const html = published.find((a) => a.role === "linkHtmlContent");
        const original = published.find((a) => a.role === "bookmarkAsset");
        if (result.assetType && original) {
          db.update(bookmarks)
            .set({ type: BookmarkTypes.ASSET })
            .where(eq(bookmarks.id, b.id))
            .run();
          db.delete(bookmarkLinks).where(eq(bookmarkLinks.id, b.id)).run();
          db.insert(bookmarkAssets)
            .values({
              id: b.id,
              assetId: original.id,
              assetType: result.assetType,
              sourceUrl: b.link?.url ?? result.sourceUrl,
              content: text,
              metadata: JSON.stringify(m),
              fileName: original.fileName,
            })
            .onConflictDoUpdate({
              target: bookmarkAssets.id,
              set: {
                assetId: original.id,
                content: text,
                metadata: JSON.stringify(m),
              },
            })
            .run();
        } else if (b.link) {
          db.update(bookmarkLinks)
            .set({
              title: str(m.title) ?? b.link.title,
              description: str(m.description) ?? b.link.description,
              author: str(m.author),
              publisher: str(m.publisher),
              datePublished: date(m.datePublished),
              dateModified: date(m.dateModified),
              imageUrl: str(m.image),
              favicon: str(m.logo),
              contentAssetId: html?.id ?? b.link.contentAssetId,
              htmlContent: html ? null : b.link.htmlContent,
              crawlStatus: "success",
              crawlStatusCode: result.statusCode ?? 200,
              crawledAt: new Date(),
              probeMetadataAt: new Date(),
              readerViewStatus: result.assessment?.status ?? "unavailable",
              readerViewScore: result.assessment?.score ?? 0,
              readerViewReasons: result.assessment
                ?.reasons as typeof bookmarkLinks.$inferInsert.readerViewReasons,
              readerViewClassifierVersion:
                result.assessment?.classifierVersion ?? 1,
            })
            .where(eq(bookmarkLinks.id, b.id))
            .run();
        } else if (b.asset) {
          db.update(bookmarkAssets)
            .set({ content: text, metadata: JSON.stringify(m) })
            .where(eq(bookmarkAssets.id, b.id))
            .run();
        }
        const next = snapshot(b.id)!;
        const document = {
          bookmarkId: b.id,
          fingerprint: sourceFingerprint(next),
          plainText: text,
          document: JSON.stringify({
            version: 1,
            parser: "karakeep",
            sourceUrl: result.sourceUrl,
            metadata: m,
            assessment: result.assessment,
            htmlAssetId: html?.id,
            rawHtmlAssetId: published.find((a) => a.role === "linkRawHtml")?.id,
            artifacts: published.map((a) => ({ id: a.id, role: a.role })),
            contentHash: createHash("sha256").update(text).digest("hex"),
            ownerContent: ownerContent(next.note, text),
          }),
          extractedAt: Date.now(),
        };
        db.insert(extractedDocuments)
          .values(document)
          .onConflictDoUpdate({
            target: extractedDocuments.bookmarkId,
            set: document,
          })
          .run();
        enqueuePipeline(next, data.runInference !== false, job.priority);
        if (
          next.link &&
          (data.archiveFullPage || config.crawler.fullPageArchive)
        )
          ledger.enqueue(
            "ingest",
            {
              bookmarkId: b.id,
              runInference: false,
              archiveFullPage: true,
              archiveOnly: true,
              storePdf: false,
            },
            { priority: job.priority },
          );
        queueWebhook(b.id, b.userId, "crawled");
        if (next.link && config.crawler.downloadVideo)
          ledger.enqueue(
            "video",
            { bookmarkId: b.id, url: next.link.url },
            { priority: job.priority },
          );
      }
      if (b && result.kind === "tags") {
        attachTags(b.id, b.userId, result.tags);
        db.update(bookmarks)
          .set({ taggingStatus: "success" })
          .where(eq(bookmarks.id, b.id))
          .run();
        queueWebhook(b.id, b.userId, "ai tagged");
        ledger.enqueue("publish", { bookmarkId: b.id, type: "index" });
      }
      if (b && result.kind === "title" && !hasBookmarkTitle(b.title)) {
        const title = normalizeGeneratedTitle(result.title);
        if (title) {
          const updated = db
            .update(bookmarks)
            .set({ title, modifiedAt: new Date() })
            .where(
              and(
                eq(bookmarks.id, b.id),
                b.title === null
                  ? isNull(bookmarks.title)
                  : eq(bookmarks.title, b.title),
              ),
            )
            .run();
          if (updated.changes) {
            ledger.enqueue("publish", { bookmarkId: b.id, type: "index" });
            // A pending embedding will prepare against the new title. Avoid a
            // second paid request during the initial processing pipeline.
            if (
              config.embedding.enableAutoIndexing &&
              !ledger.sqlite
                .prepare(
                  "SELECT 1 FROM work_jobs WHERE subject=? AND kind='embedding' AND state='pending' AND json_extract(payload,'$.type')='embed'",
                )
                .get(b.id)
            ) {
              ledger.enqueue("embedding", {
                bookmarkId: b.id,
                type: "embed",
                runTaggingOnComplete: b.taggingStatus === "pending",
              });
            }
            queueWebhook(b.id, b.userId, "edited");
          }
        }
      }
      if (b && result.kind === "summary") {
        db.update(bookmarks)
          .set({ summary: result.summary, summarizationStatus: "success" })
          .where(eq(bookmarks.id, b.id))
          .run();
        ledger.enqueue("publish", { bookmarkId: b.id, type: "index" });
      }
      if (b && result.kind === "embedding") {
        ledger.enqueue("embedding", {
          bookmarkId: b.id,
          type: "index",
          userId: b.userId,
          embedding: result.embedding,
          expectedFingerprint: job.fingerprint,
        });
        if (data.runTaggingOnComplete !== false)
          ledger.enqueue("ai", {
            bookmarkId: b.id,
            type: "tag",
            embedding: result.embedding,
            expectedFingerprint: job.fingerprint,
          });
      }
      if (b && result.kind === "done") {
        if (job.kind === "ai" && data.type !== "title")
          db.update(bookmarks)
            .set(
              data.type === "summarize"
                ? { summarizationStatus: result.skipped ? null : "success" }
                : { taggingStatus: result.skipped ? null : "success" },
            )
            .where(eq(bookmarks.id, b.id))
            .run();
        if (job.kind === "embedding" && data.type === "index")
          db.update(bookmarks)
            .set({ embeddingStatus: result.skipped ? null : "success" })
            .where(eq(bookmarks.id, b.id))
            .run();
        if (
          job.kind === "embedding" &&
          data.type === "embed" &&
          result.skipped
        ) {
          db.update(bookmarks)
            .set({ embeddingStatus: null })
            .where(eq(bookmarks.id, b.id))
            .run();
          if (data.runTaggingOnComplete !== false)
            ledger.enqueue("ai", { bookmarkId: b.id, type: "tag" });
        }
      }
      if (job.kind === "export" && result.kind === "artifacts") {
        const asset = published.find((a) => a.role === "backup");
        if (asset)
          ledger.sqlite
            .prepare(
              "UPDATE backups SET status='success',assetId=?,size=?,bookmarkCount=?,errorMessage=NULL WHERE id=? AND userId=?",
            )
            .run(
              asset.id,
              asset.size,
              result.bookmarkCount ?? 0,
              data.backupId,
              userId,
            );
        ledger.enqueue("maintenance", { type: "prune_backups", userId });
      }
      ledger.finish(job.id, job.token!);
      if (job.kind === "feed") {
        const feed = ledger.sqlite
          .prepare("SELECT enabled FROM rssFeeds WHERE id=?")
          .get(data.feedId) as { enabled: number } | undefined;
        if (feed?.enabled)
          ledger.enqueue(
            "feed",
            { feedId: data.feedId },
            { delayMs: 3600_000, subject: `feed:${data.feedId}` },
          );
      }
      if (job.kind === "export" && data.scheduled) {
        const u = ledger.sqlite
          .prepare(
            "SELECT backupsEnabled,backupsFrequency FROM user WHERE id=?",
          )
          .get(data.userId) as
          | { backupsEnabled: number; backupsFrequency: string }
          | undefined;
        if (u?.backupsEnabled)
          ledger.enqueue(
            "export",
            { userId: data.userId },
            {
              delayMs:
                u.backupsFrequency === "daily" ? 86400_000 : 7 * 86400_000,
              subject: `export:${data.userId}`,
            },
          );
      }
      updateImportProgress();
      ledger.sqlite
        .prepare(
          "UPDATE work_settings SET value='0' WHERE key='applying_result'",
        )
        .run();
    })
    .immediate();
  for (const id of oldAssets) if (userId) await silentDeleteAsset(userId, id);
  await rm(path.join(stagingRoot(), job.id), { recursive: true, force: true });
  return true;
}

export function markFailure(job: WorkJob) {
  const ledger = workLedger(),
    data = JSON.parse(job.payload);
  if (job.state !== "failed") return;
  ledger.sqlite
    .transaction(() => {
      if (job.kind === "ingest" || job.kind === "asset") {
        if (job.kind === "ingest")
          ledger.sqlite
            .prepare(
              "UPDATE bookmarkLinks SET crawlStatus='failure' WHERE id=?",
            )
            .run(data.bookmarkId);
        ledger.sqlite
          .prepare(
            "UPDATE bookmarks SET taggingStatus=NULL,summarizationStatus=NULL,embeddingStatus=NULL WHERE id=?",
          )
          .run(data.bookmarkId);
        const b = snapshot(data.bookmarkId);
        if (b) queueTitle(b);
      }
      if (job.kind === "ai" && data.type !== "title")
        ledger.sqlite
          .prepare(
            `UPDATE bookmarks SET ${data.type === "summarize" ? "summarizationStatus" : "taggingStatus"}='failure' WHERE id=?`,
          )
          .run(data.bookmarkId);
      if (job.kind === "embedding" && data.type !== "delete") {
        ledger.sqlite
          .prepare("UPDATE bookmarks SET embeddingStatus='failure' WHERE id=?")
          .run(data.bookmarkId);
        if (data.type === "embed" && data.runTaggingOnComplete !== false)
          ledger.enqueue("ai", { bookmarkId: data.bookmarkId, type: "tag" });
      }
      if (job.kind === "export" && data.backupId)
        ledger.sqlite
          .prepare(
            "UPDATE backups SET status='failure',errorMessage='Background export failed' WHERE id=?",
          )
          .run(data.backupId);
      if (job.kind === "feed") {
        ledger.sqlite
          .prepare(
            "UPDATE rssFeeds SET lastFetchedStatus='failure',lastFetchedAt=unixepoch() WHERE id=?",
          )
          .run(data.feedId);
        ledger.enqueue(
          "feed",
          { feedId: data.feedId },
          { delayMs: 3600_000, subject: `feed:${data.feedId}` },
        );
      }
      updateImportProgress();
    })
    .immediate();
}
