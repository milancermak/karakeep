import { createWriteStream } from "node:fs";
import { readdir, stat, rm } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { db } from "@karakeep/db";
import {
  bookmarksInLists,
  importSessions,
  importStagingBookmarks,
  rssFeedsTable,
  rssFeedImportsTable,
} from "@karakeep/db/schema";
import {
  toExportFormat,
  toExportListFormat,
} from "@karakeep/shared/import-export/exporters";
import { zAdminMaintenanceTaskSchema } from "@karakeep/shared-server";
import type { WorkJob } from "@karakeep/shared-server/work/ledger";
import { workLedger } from "@karakeep/shared-server/work/runtime";
import { zRuleEngineRequestSchema } from "@karakeep/shared-server";
import type { WorkResult } from "@karakeep/shared-server/work/contracts";
import {
  BookmarkTypes,
  MAX_BOOKMARK_TITLE_LENGTH,
} from "@karakeep/shared/types/bookmarks";
import { createCallerFactory } from "../..";
import { appRouter } from "../../routers/_app";
import { buildImpersonatingAuthedContext } from "../../lib/impersonate";
import { RuleEngine } from "../../lib/ruleEngine";
import { Bookmark } from "../../models/bookmarks";
import { List } from "../../models/lists";
import { Backup } from "../../models/backups";
import { ImportSessionsService } from "../../models/importSessions.service";
import config from "@karakeep/shared/config";
import { getAllAssets, deleteAsset } from "@karakeep/shared-server";
import { snapshot, updateImportProgress } from "./model";

async function caller(userId: string, importItemId?: string) {
  const ctx = await buildImpersonatingAuthedContext(userId);
  return createCallerFactory(appRouter)({
    ...ctx,
    req: { ...ctx.req, processingImportItemId: importItemId },
  });
}

export async function applyFeed(
  job: WorkJob,
  result: Extract<WorkResult, { kind: "feed" }>,
) {
  const { feedId } = JSON.parse(job.payload) as { feedId: string };
  const feed = await db.query.rssFeedsTable.findFirst({
    where: eq(rssFeedsTable.id, feedId),
  });
  if (!feed?.enabled) return;
  const api = await caller(feed.userId);
  // Applying a checkpoint is repeatable: entry IDs and createBookmark dedup
  // protect already-applied items if a process dies partway through a feed.
  for (const item of result.items) {
    const existing = workLedger()
      .sqlite.prepare(
        "SELECT bookmarkId FROM rssFeedImports WHERE rssFeedId=? AND entryId=?",
      )
      .get(feedId, item.guid) as { bookmarkId: string | null } | undefined;
    if (existing?.bookmarkId) continue;
    const bookmark = await api.bookmarks.createBookmark({
      type: BookmarkTypes.LINK,
      url: item.link,
      title: item.title,
      source: "rss",
    });
    if (feed.importTags && item.categories.length)
      await api.bookmarks.updateTags({
        bookmarkId: bookmark.id,
        attach: item.categories.map((tagName) => ({ tagName })),
        detach: [],
      });
    await db
      .insert(rssFeedImportsTable)
      .values({
        rssFeedId: feedId,
        entryId: item.guid,
        bookmarkId: bookmark.id,
      })
      .onConflictDoUpdate({
        target: [rssFeedImportsTable.rssFeedId, rssFeedImportsTable.entryId],
        set: { bookmarkId: bookmark.id },
      });
  }
  await db
    .update(rssFeedsTable)
    .set({
      // Public dates have second resolution. Preserve a visible change even
      // when two requested refreshes finish inside the same second.
      lastFetchedAt: new Date(
        Math.max(
          Date.now(),
          (feed.lastSuccessfulFetchAt?.getTime() ?? 0) + 1000,
        ),
      ),
      lastSuccessfulFetchAt: new Date(
        Math.max(
          Date.now(),
          (feed.lastSuccessfulFetchAt?.getTime() ?? 0) + 1000,
        ),
      ),
      lastFetchedStatus: "success",
    })
    .where(eq(rssFeedsTable.id, feedId));
}

async function importBatch(job: WorkJob) {
  const { importSessionId } = JSON.parse(job.payload) as {
    importSessionId: string;
  };
  const session = await db.query.importSessions.findFirst({
    where: eq(importSessions.id, importSessionId),
  });
  if (!session || !["pending", "running"].includes(session.status)) return;
  await db
    .update(importSessions)
    .set({ status: "running" })
    .where(eq(importSessions.id, session.id));
  // Recover interrupted records immediately; the ledger serializes a session.
  const inflight = workLedger()
    .sqlite.prepare(
      "SELECT count(*) n FROM importStagingBookmarks WHERE importSessionId=? AND status='processing'",
    )
    .get(session.id) as { n: number };
  if (inflight.n >= 50) return;
  const staged = await db.query.importStagingBookmarks.findMany({
    where: and(
      eq(importStagingBookmarks.importSessionId, session.id),
      or(
        eq(importStagingBookmarks.status, "pending"),
        and(
          eq(importStagingBookmarks.status, "processing"),
          eq(importStagingBookmarks.resultReason, "applying_metadata"),
        ),
      ),
    ),
    limit: Math.min(10, 50 - inflight.n),
  });
  for (const item of staged) {
    const state = await db.query.importSessions.findFirst({
      where: eq(importSessions.id, session.id),
    });
    if (state?.status !== "running") break;
    if (
      item.status === "processing" &&
      item.resultBookmarkId &&
      item.resultReason !== "applying_metadata"
    )
      continue;
    await db
      .update(importStagingBookmarks)
      .set({ status: "processing", processingStartedAt: new Date() })
      .where(eq(importStagingBookmarks.id, item.id));
    try {
      if (item.type === "asset")
        throw new Error("Asset import is not supported");
      const api = await caller(session.userId, item.id);
      const base = {
        title:
          item.title?.trim().slice(0, MAX_BOOKMARK_TITLE_LENGTH) || undefined,
        note: item.note ?? undefined,
        createdAt: item.sourceAddedAt ?? undefined,
        archived: item.archived ?? false,
        crawlPriority: "low" as const,
        source: "import" as const,
      };
      const known = workLedger()
        .sqlite.prepare(
          "SELECT resultBookmarkId FROM importStagingBookmarks WHERE id=?",
        )
        .get(item.id) as { resultBookmarkId: string | null };
      const created = known.resultBookmarkId
        ? { id: known.resultBookmarkId, alreadyExists: false }
        : item.type === "link"
          ? await api.bookmarks.createBookmark({
              ...base,
              type: BookmarkTypes.LINK,
              url: item.url!,
            })
          : await api.bookmarks.createBookmark({
              ...base,
              type: BookmarkTypes.TEXT,
              text: item.content!,
            });
      if (item.tags?.length)
        await api.bookmarks.updateTags({
          bookmarkId: created.id,
          attach: item.tags.map((tagName) => ({ tagName })),
          detach: [],
        });
      for (const listId of new Set([
        ...(item.listIds ?? []),
        ...(session.rootListId ? [session.rootListId] : []),
      ])) {
        const ctx = await buildImpersonatingAuthedContext(session.userId);
        const list = await List.fromId(ctx, listId);
        await list.addBookmark(created.id);
      }
      await db
        .update(importStagingBookmarks)
        .set({
          resultBookmarkId: created.id,
          result: created.alreadyExists ? "skipped_duplicate" : "accepted",
          status: created.alreadyExists ? "completed" : "processing",
          completedAt: created.alreadyExists ? new Date() : null,
          resultReason: null,
        })
        .where(eq(importStagingBookmarks.id, item.id));
    } catch {
      await db
        .update(importStagingBookmarks)
        .set({
          status: "failed",
          result: "rejected",
          resultReason: "Import item could not be saved",
          completedAt: new Date(),
        })
        .where(eq(importStagingBookmarks.id, item.id));
    }
    await db
      .update(importSessions)
      .set({ lastProcessedAt: new Date() })
      .where(eq(importSessions.id, session.id));
  }
  const remaining = workLedger()
    .sqlite.prepare(
      "SELECT 1 FROM importStagingBookmarks WHERE importSessionId=? AND status='pending' LIMIT 1",
    )
    .get(session.id);
  if (remaining)
    workLedger().enqueue(
      "import",
      { importSessionId: session.id },
      { subject: `import:${session.id}`, priority: 50 },
    );
  updateImportProgress();
}

export async function prepareExport(
  job: WorkJob,
  dir: string,
): Promise<Record<string, unknown>> {
  const ledger = workLedger(),
    data = JSON.parse(job.payload) as {
      userId: string;
      backupId?: string;
      scheduled?: boolean;
    };
  const user = ledger.sqlite
    .prepare("SELECT backupsEnabled,backupsFrequency FROM user WHERE id=?")
    .get(data.userId) as
    | { backupsEnabled: number; backupsFrequency: string }
    | undefined;
  if (!user || (!data.backupId && !user.backupsEnabled))
    return { operation: "noop" };
  if (!data.backupId) {
    data.backupId = randomUUID();
    data.scheduled = true;
    ledger.sqlite
      .transaction(() => {
        ledger.sqlite
          .prepare(
            "INSERT INTO backups(id,userId,size,bookmarkCount,status,createdAt) VALUES (?,?,0,0,'pending',unixepoch())",
          )
          .run(data.backupId!, data.userId);
        ledger.sqlite
          .prepare("UPDATE work_jobs SET payload=? WHERE id=? AND token=?")
          .run(JSON.stringify(data), job.id, job.token);
      })
      .immediate();
  }
  const ctx = await buildImpersonatingAuthedContext(data.userId);
  const lists = await List.getAllOwned(ctx);
  const output = path.join(dir, "export.json"),
    stream = createWriteStream(output, { mode: 0o600 });
  const write = async (s: string) => {
    if (!stream.write(s)) await once(stream, "drain");
  };
  let count = 0;
  try {
    await write(
      `{"lists":${JSON.stringify(lists.map((l) => toExportListFormat(l.asZBookmarkList())))},"bookmarks":[`,
    );
    let cursor = null;
    do {
      const page = await Bookmark.loadMulti(ctx, {
        limit: 500,
        cursor,
        sortOrder: "asc",
        includeContent: false,
      });
      for (const bookmark of page.bookmarks) {
        const listIds = (
          await db
            .select({ listId: bookmarksInLists.listId })
            .from(bookmarksInLists)
            .where(eq(bookmarksInLists.bookmarkId, bookmark.id))
        ).map((v) => v.listId);
        const value = toExportFormat(bookmark.asZBookmark(), listIds);
        if (value.content) {
          await write((count++ ? "," : "") + JSON.stringify(value));
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    await write("]}");
    stream.end();
    await once(stream, "finish");
  } catch (e) {
    stream.destroy();
    throw e;
  }
  return { operation: "export", jsonPath: output, bookmarkCount: count };
}

export async function runDomainOperation(job: WorkJob) {
  if (job.kind === "import") return importBatch(job);
  const data = JSON.parse(job.payload);
  if (job.kind === "rules") {
    const input = zRuleEngineRequestSchema.parse(data),
      b = await snapshot(input.bookmarkId);
    if (!b) return;
    const engine = await RuleEngine.forBookmark(
      await buildImpersonatingAuthedContext(b.userId),
      b.id,
    );
    for (const event of input.events) await engine?.onEvent(event);
    return;
  }
  if (job.kind === "maintenance") {
    if (data.type === "engine_cleanup") {
      workLedger()
        .sqlite.prepare(
          "DELETE FROM work_jobs WHERE state IN ('completed','obsolete') AND updatedAt<?",
        )
        .run(Date.now() - 7 * 86400_000);
      await new ImportSessionsService(db).archiveCompletedSystem(
        new Date(Date.now() - 30 * 86400_000),
      );
      const root = path.resolve(config.dataDir || ".", "work-staging");
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(root, entry.name);
        const job = workLedger().get(entry.name);
        if (
          job?.state !== "running" &&
          (await stat(file)).mtimeMs < Date.now() - 86400_000
        )
          await rm(file, { recursive: true, force: true });
      }
      for await (const asset of getAllAssets()) {
        if (!/^[0-9a-f-]{36}-[a-zA-Z]+$/.test(asset.assetId)) continue;
        if (
          workLedger()
            .sqlite.prepare("SELECT 1 FROM assets WHERE id=?")
            .get(asset.assetId)
        )
          continue;
        const info = await stat(
          path.join(config.assetsDir, asset.userId, asset.assetId, "asset.bin"),
        ).catch(() => null);
        if (info && info.mtimeMs < Date.now() - 86400_000)
          await deleteAsset({ userId: asset.userId, assetId: asset.assetId });
      }
      workLedger().enqueue(
        "maintenance",
        { type: "engine_cleanup" },
        { delayMs: 86400_000 },
      );
      return;
    }
    if (data.type === "prune_backups") {
      const ctx = await buildImpersonatingAuthedContext(data.userId);
      const user = workLedger()
        .sqlite.prepare("SELECT backupsRetentionDays FROM user WHERE id=?")
        .get(data.userId) as { backupsRetentionDays: number };
      for (const backup of await Backup.findOldBackups(
        ctx,
        user.backupsRetentionDays,
      ))
        await backup.delete();
      return;
    }
    const task = zAdminMaintenanceTaskSchema.parse(data);
    const request = {
      id: job.id,
      data: task,
      priority: job.priority,
      runNumber: job.attempts - 1,
      abortSignal: AbortSignal.timeout(550_000),
    };
    switch (task.type) {
      case "tidy_assets":
        return (await import("./maintenance/tidyAssets")).runTidyAssetsTask(
          { ...request, data: task },
          task,
        );
      case "migrate_large_link_html":
        return (
          await import("./maintenance/migrateLinkHtmlContent")
        ).runMigrateLargeLinkHtmlTask({ ...request, data: task });
      case "purge_bookmarks_over_quota":
        return (
          await import("./maintenance/purgeBookmarksOverQuota")
        ).runPurgeBookmarksOverQuotaTask(request, task);
    }
  }
}
