import { eq } from "drizzle-orm";
import { db } from "@karakeep/db";
import { bookmarks } from "@karakeep/db/schema";
import serverConfig from "@karakeep/shared/config";
import { bookmarkMetadataSearchText } from "@karakeep/shared/types/metadata";
import type { BookmarkMetadata } from "@karakeep/shared/types/metadata";
import { digest } from "@karakeep/shared-server/work/ledger";
import type { WorkJob } from "@karakeep/shared-server/work/ledger";
import { workLedger } from "@karakeep/shared-server/work/runtime";
import { Bookmark } from "../../models/bookmarks";

export function snapshot(id: string) {
  return db.query.bookmarks
    .findFirst({
      where: eq(bookmarks.id, id),
      with: {
        link: true,
        text: true,
        asset: true,
        assets: true,
        user: true,
        tagsOnBookmarks: { with: { tag: true } },
      },
    })
    .sync();
}
export type Snapshot = NonNullable<Awaited<ReturnType<typeof snapshot>>>;

export function sourceFingerprint(b: Snapshot): string {
  return digest({
    type: b.type,
    url: b.link?.url,
    text: b.text?.text,
    assetId: b.asset?.assetId,
  });
}

export function fingerprint(b: Snapshot): string {
  const prompts = workLedger()
    .sqlite.prepare(
      "SELECT appliesTo,text FROM customPrompts WHERE userId=? ORDER BY id",
    )
    .all(b.userId);
  return digest({
    source: sourceFingerprint(b),
    title: b.title,
    note: b.note,
    metadataText: bookmarkMetadataSearchText(b.metadata),
    autoTagging: b.user.autoTaggingEnabled,
    autoSummary: b.user.autoSummarizationEnabled,
    tagStyle: b.user.tagStyle,
    language: b.user.inferredTagLang,
    curated: b.user.curatedTagIds,
    prompts,
  });
}

export async function plainText(b: Snapshot): Promise<string> {
  const sql = workLedger().sqlite;
  const cached = sql
    .prepare(
      "SELECT fingerprint,plainText FROM extracted_documents WHERE bookmarkId=?",
    )
    .get(b.id) as { fingerprint: string; plainText: string } | undefined;
  if (cached?.fingerprint === sourceFingerprint(b)) return cached.plainText;
  const text =
    b.text?.text ??
    b.asset?.content ??
    (b.link
      ? await Bookmark.getBookmarkPlainTextContent(b.link, b.userId)
      : "") ??
    "";
  // Existing saved content gets a manifest lazily; new extraction supplies a
  // richer document in the result handler. No whole-library migration is needed.
  sql
    .prepare(`INSERT INTO extracted_documents(bookmarkId,fingerprint,document,plainText,extractedAt)
    VALUES (?,?,?,?,?) ON CONFLICT(bookmarkId) DO UPDATE SET
      fingerprint=excluded.fingerprint,plainText=excluded.plainText,document=excluded.document,
      extractedAt=excluded.extractedAt`)
    .run(
      b.id,
      sourceFingerprint(b),
      JSON.stringify({
        version: 1,
        parser: "existing",
        sourceUrl: b.link?.url ?? b.text?.sourceUrl ?? b.asset?.sourceUrl,
        htmlAssetId: b.link?.contentAssetId,
      }),
      text,
      Date.now(),
    );
  return text;
}

export function enqueuePipeline(
  b: Snapshot,
  runInference = true,
  priority = 0,
) {
  const ledger = workLedger();
  if (runInference) {
    if (serverConfig.embedding.enableAutoIndexing)
      ledger.enqueue(
        "embedding",
        {
          bookmarkId: b.id,
          type: "embed",
          runTaggingOnComplete: true,
        },
        { priority },
      );
    else ledger.enqueue("ai", { bookmarkId: b.id, type: "tag" }, { priority });
    ledger.enqueue("ai", { bookmarkId: b.id, type: "summarize" }, { priority });
  }
  ledger.enqueue("publish", { bookmarkId: b.id, type: "index" }, { priority });
}

export function queueInitial(b: Snapshot, priority = 0) {
  const ledger = workLedger();
  if (b.link)
    ledger.enqueue(
      "ingest",
      {
        bookmarkId: b.id,
        runInference: true,
        archiveFullPage: false,
        storePdf: false,
      },
      { priority },
    );
  else if (b.asset)
    ledger.enqueue("asset", { bookmarkId: b.id, fixMode: false }, { priority });
  else enqueuePipeline(b, true, priority);
}

export function queueWebhook(
  bookmarkId: string,
  userId: string,
  operation: string,
) {
  const ledger = workLedger();
  const configured = ledger.sqlite
    .prepare("SELECT 1 FROM webhooks WHERE userId=? LIMIT 1")
    .get(userId);
  if (configured) ledger.enqueue("webhook", { bookmarkId, userId, operation });
}

export function queueRules(
  bookmarkId: string,
  userId: string,
  events: unknown[],
) {
  const ledger = workLedger();
  if (
    events.length &&
    ledger.sqlite
      .prepare(
        "SELECT 1 FROM ruleEngineRules WHERE userId=? AND enabled=1 LIMIT 1",
      )
      .get(userId)
  )
    ledger.enqueue("rules", { bookmarkId, events });
}

export async function processDomainEvent(job: WorkJob): Promise<void> {
  const data = JSON.parse(job.payload) as {
    bookmarkId: string;
    userId?: string;
    operation: string;
    tagId?: string;
    listId?: string;
    previousContext?: {
      title: string | null;
      note: string | null;
      summary: string | null;
      metadata: BookmarkMetadata;
    };
  };
  const ledger = workLedger();
  if (data.operation === "import") {
    ledger.enqueue(
      "import",
      { importSessionId: data.bookmarkId },
      { subject: `import:${data.bookmarkId}`, priority: 50 },
    );
    return;
  }
  if (data.operation === "feed") {
    ledger.enqueue(
      "feed",
      { feedId: data.bookmarkId },
      { subject: `feed:${data.bookmarkId}` },
    );
    return;
  }
  if (data.operation === "export" || data.operation === "backup_schedule") {
    ledger.enqueue(
      "export",
      {
        userId: data.userId,
        ...(data.operation === "export" ? { backupId: data.bookmarkId } : {}),
      },
      { subject: `export:${data.userId}` },
    );
    return;
  }
  const b = snapshot(data.bookmarkId);
  // There are no awaits inside this transaction: follow-up work and event
  // completion commit together, including the deletion tombstone payload.
  ledger.sqlite
    .transaction(() => {
      if (!ledger.active(job.id, job.token!)) return;
      if (data.operation === "deleted" || !b) {
        ledger.enqueue("publish", {
          bookmarkId: data.bookmarkId,
          type: "delete",
        });
        ledger.enqueue("embedding", {
          bookmarkId: data.bookmarkId,
          type: "delete",
        });
        if (data.userId) queueWebhook(data.bookmarkId, data.userId, "deleted");
      } else {
        if (
          [
            "tagAdded",
            "tagRemoved",
            "addedToList",
            "removedFromList",
            "favourited",
            "archived",
          ].includes(data.operation)
        )
          queueRules(b.id, b.userId, [
            {
              type: data.operation,
              ...(data.tagId ? { tagId: data.tagId } : {}),
              ...(data.listId ? { listId: data.listId } : {}),
            },
          ]);
        if (data.operation === "created" || data.operation === "source") {
          queueInitial(b);
          if (data.operation === "created")
            queueRules(b.id, b.userId, [{ type: "bookmarkAdded" }]);
        }
        if (data.operation === "created" || data.operation === "edited")
          queueWebhook(b.id, b.userId, data.operation);
        if (
          data.operation === "edited" &&
          serverConfig.embedding.enableAutoIndexing
        ) {
          const old = data.previousContext;
          if (
            !old ||
            old.title !== b.title ||
            old.note !== b.note ||
            old.summary !== b.summary ||
            bookmarkMetadataSearchText(old.metadata) !==
              bookmarkMetadataSearchText(b.metadata)
          ) {
            ledger.enqueue("embedding", {
              bookmarkId: b.id,
              type: "embed",
              runTaggingOnComplete: false,
            });
          }
        }
        ledger.enqueue("publish", { bookmarkId: b.id, type: "index" });
      }
      ledger.finish(job.id, job.token!);
    })
    .immediate();
}

/** Completion events replace the previous five-second import progress scan. */
export function updateImportProgress() {
  const sql = workLedger().sqlite;
  sql
    .prepare(`UPDATE importStagingBookmarks SET status='completed',completedAt=unixepoch()
    WHERE status='processing' AND resultBookmarkId IS NOT NULL AND coalesce(resultReason,'')!='applying_metadata'
    AND NOT EXISTS(SELECT 1 FROM work_jobs w WHERE w.subject=resultBookmarkId
      AND w.state IN ('pending','running') AND w.kind IN ('ingest','asset','ai','embedding'))`)
    .run();
  sql
    .prepare(`UPDATE importSessions SET
    completedBookmarks=(SELECT count(*) FROM importStagingBookmarks s WHERE s.importSessionId=importSessions.id AND s.status='completed'),
    failedBookmarks=(SELECT count(*) FROM importStagingBookmarks s WHERE s.importSessionId=importSessions.id AND s.status='failed'),
    pendingBookmarks=(SELECT count(*) FROM importStagingBookmarks s WHERE s.importSessionId=importSessions.id AND s.status='pending'),
    processingBookmarks=(SELECT count(*) FROM importStagingBookmarks s WHERE s.importSessionId=importSessions.id AND s.status='processing')
    WHERE status IN ('pending','running')`)
    .run();
  sql
    .prepare(`UPDATE importSessions SET status='completed',completedAt=unixepoch()
    WHERE status IN ('pending','running') AND pendingBookmarks=0 AND processingBookmarks=0`)
    .run();
  const ready = sql
    .prepare(
      "SELECT id FROM importSessions WHERE status IN ('pending','running') AND pendingBookmarks>0 AND processingBookmarks<50",
    )
    .all() as { id: string }[];
  for (const session of ready)
    workLedger().enqueue(
      "import",
      { importSessionId: session.id },
      { subject: `import:${session.id}`, priority: 50 },
    );
}
