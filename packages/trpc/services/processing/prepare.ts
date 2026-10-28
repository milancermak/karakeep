import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@karakeep/db";
import {
  bookmarkTags,
  customPrompts,
  tagsOnBookmarks,
} from "@karakeep/db/schema";
import { createAssetReadStream } from "@karakeep/shared-server";
import type { PreparedWork } from "@karakeep/shared-server/work/contracts";
import type { WorkJob } from "@karakeep/shared-server/work/ledger";
import { workLedger } from "@karakeep/shared-server/work/runtime";
import config from "@karakeep/shared/config";
import {
  buildImagePrompt,
  constructTextTaggingPrompt,
  constructSummaryPrompt,
} from "@karakeep/shared/prompts";
import { getVectorStoreClient } from "@karakeep/shared/vectorStore";
import { fingerprint, plainText, snapshot } from "./model";
import type { Snapshot } from "./model";
import { prepareExport } from "./operations";

export const stagingRoot = () =>
  path.resolve(config.dataDir || ".", "work-staging");

async function materialize(
  userId: string,
  assetId: string,
  dir: string,
  name: string,
) {
  const target = path.join(dir, name);
  await pipeline(
    await createAssetReadStream({ userId, assetId }),
    createWriteStream(target, { mode: 0o600 }),
  );
  return target;
}

async function customPromptTexts(
  b: Snapshot,
  appliesTo: "text" | "images" | "summary",
) {
  const prompts = await db.query.customPrompts.findMany({
    where: and(
      eq(customPrompts.userId, b.userId),
      inArray(
        customPrompts.appliesTo,
        appliesTo === "summary" ? ["summary"] : ["all_tagging", appliesTo],
      ),
    ),
  });
  const tags = await db.query.bookmarkTags.findMany({
    where: eq(bookmarkTags.userId, b.userId),
  });
  const human = new Set(
    (
      await db
        .select({ tagId: tagsOnBookmarks.tagId })
        .from(tagsOnBookmarks)
        .where(eq(tagsOnBookmarks.attachedBy, "human"))
    ).map((t) => t.tagId),
  );
  return prompts.map((p) =>
    p.text
      .replaceAll("$tags", `[${tags.map((t) => t.name).join(", ")}]`)
      .replaceAll(
        "$aiTags",
        `[${tags
          .filter((t) => !human.has(t.id))
          .map((t) => t.name)
          .join(", ")}]`,
      )
      .replaceAll(
        "$userTags",
        `[${tags
          .filter((t) => human.has(t.id))
          .map((t) => t.name)
          .join(", ")}]`,
      ),
  );
}

async function taggingContext(b: Snapshot, embedding: unknown) {
  if (b.user.curatedTagIds?.length) {
    const tags = await db.query.bookmarkTags.findMany({
      where: and(
        eq(bookmarkTags.userId, b.userId),
        inArray(bookmarkTags.id, b.user.curatedTagIds),
      ),
    });
    return { curated: tags.map((t) => t.name), relevant: undefined };
  }
  try {
    const client = await getVectorStoreClient();
    if (!client) return {};
    const filter = [
      { type: "eq" as const, field: "userId" as const, value: b.userId },
    ];
    const hits = Array.isArray(embedding)
      ? await client.search({
          vector: embedding,
          limit: 11,
          filter,
          rankingScoreThreshold: 0.75,
        })
      : await client.findSimilar({ id: b.id, limit: 10, filter });
    const ids = hits.hits
      .filter((h) => h.id !== b.id)
      .slice(0, 10)
      .map((h) => h.id);
    if (!ids.length) return {};
    const tags = await db
      .selectDistinct({ name: bookmarkTags.name })
      .from(bookmarkTags)
      .innerJoin(tagsOnBookmarks, eq(tagsOnBookmarks.tagId, bookmarkTags.id))
      .where(
        and(
          eq(bookmarkTags.userId, b.userId),
          inArray(tagsOnBookmarks.bookmarkId, ids),
        ),
      )
      .limit(100);
    const relevant: string[] = [];
    let size = 0;
    for (const t of tags.sort((a, b) => a.name.length - b.name.length)) {
      if (size + t.name.length + 2 > 1000) break;
      relevant.push(t.name);
      size += t.name.length + 2;
    }
    return { relevant };
  } catch {
    return {};
  }
}

async function prepareAI(
  b: Snapshot,
  data: Record<string, unknown>,
  dir: string,
) {
  const summary = data.type === "summarize";
  if (
    !config.inference.isConfigured ||
    (summary
      ? !config.inference.enableAutoSummarization ||
        b.user.autoSummarizationEnabled === false ||
        !b.link
      : !config.inference.enableAutoTagging ||
        b.user.autoTaggingEnabled === false)
  )
    return { operation: "noop" };
  const image = b.asset?.assetType === "image";
  const text = await plainText(b);
  if (!image && !text && !b.link?.description) return { operation: "noop" };
  const { curated, relevant } = summary
    ? {}
    : await taggingContext(b, data.embedding);
  const lang = b.user.inferredTagLang ?? config.inference.inferredTagLang;
  const prompts = await customPromptTexts(
    b,
    summary ? "summary" : image ? "images" : "text",
  );
  const template = summary
    ? constructSummaryPrompt(lang, prompts, "{{CONTENT}}")
    : image
      ? buildImagePrompt(
          lang,
          prompts,
          b.user.tagStyle ?? "as-generated",
          curated,
          relevant,
        )
      : constructTextTaggingPrompt(
          lang,
          prompts,
          "{{CONTENT}}",
          b.user.tagStyle ?? "as-generated",
          curated,
          relevant,
        );
  const input: Record<string, unknown> = {
    operation: summary ? "summary" : "tags",
    template,
    content: b.link
      ? `URL: ${b.link.url}\nTitle: ${b.link.title ?? ""}\nDescription: ${b.link.description ?? ""}\nContent: ${text}`
      : text,
    model: image ? config.inference.imageModel : config.inference.textModel,
    contextLength: config.inference.contextLength,
    maxOutputTokens: config.inference.maxOutputTokens,
    useMaxCompletionTokens: config.inference.useMaxCompletionTokens,
    outputSchema: config.inference.outputSchema,
    reasoningEffort: config.inference.openAIReasoningEffort,
    serviceTier: config.inference.openAIServiceTier,
  };
  if (image && b.asset) {
    const metadata = b.assets.find((a) => a.id === b.asset!.assetId);
    if (metadata?.contentType === "image/gif") return { operation: "noop" };
    input.imagePath = await materialize(
      b.userId,
      b.asset.assetId,
      dir,
      "image.bin",
    );
    input.imageContentType = metadata?.contentType ?? "image/png";
  }
  return input;
}

export async function prepareJob(job: WorkJob): Promise<PreparedWork> {
  const ledger = workLedger(),
    data = JSON.parse(job.payload) as Record<string, unknown>;
  const dir = path.join(stagingRoot(), job.id, job.token!);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const b =
    typeof data.bookmarkId === "string"
      ? await snapshot(data.bookmarkId)
      : undefined;
  const current = b ? fingerprint(b) : null;
  let input: Record<string, unknown> = { operation: "noop" };
  let timeoutSecs = 120;
  if (data.expectedFingerprint && data.expectedFingerprint !== current)
    input = { operation: "noop" };
  else
    switch (job.kind) {
      case "ingest": {
        if (!b?.link) break;
        if (
          data.archiveOnly ||
          (data.archiveFullPage && data.runInference === false)
        ) {
          input = { operation: "archive", url: b.link.url };
          timeoutSecs = Math.max(30, config.crawler.monolithTimeoutSec + 10);
          break;
        }
        input = {
          operation: "ingest",
          url: b.link.url,
          headless:
            config.crawler.headlessBrowser &&
            b.user.browserCrawlingEnabled !== false,
          storeScreenshot: config.crawler.storeScreenshot,
          fullPageScreenshot: config.crawler.fullPageScreenshot,
          storePdf: data.storePdf || config.crawler.storePdf,
          fullPageArchive: false,
          downloadBanner: config.crawler.downloadBannerImage,
          maxBytes: config.maxAssetSizeMb * 1024 * 1024,
          ocrLangs: config.ocr.langs,
          ocrConfidence: config.ocr.confidenceThreshold,
          ocrUseLLM: config.ocr.useLLM,
        };
        const precrawled = b.assets
          .filter((a) => a.assetType === "linkPrecrawledArchive")
          .at(-1);
        if (precrawled)
          input.htmlPath = await materialize(
            b.userId,
            precrawled.id,
            dir,
            "precrawled.html",
          );
        timeoutSecs = Math.max(
          config.crawler.jobTimeoutSec,
          config.crawler.parseTimeoutSec +
            config.crawler.navigateTimeoutSec +
            20,
        );
        break;
      }
      case "asset": {
        if (!b?.asset) break;
        input = {
          operation: "asset",
          assetType: b.asset.assetType,
          assetPath: await materialize(
            b.userId,
            b.asset.assetId,
            dir,
            "input.bin",
          ),
          contentType: b.assets.find((a) => a.id === b.asset!.assetId)
            ?.contentType,
          ocrLangs: config.ocr.langs,
          ocrConfidence: config.ocr.confidenceThreshold,
          ocrUseLLM: config.ocr.useLLM,
        };
        timeoutSecs = config.assetPreprocessing.jobTimeoutSec;
        break;
      }
      case "ai":
        if (b) {
          input = await prepareAI(b, data, dir);
          timeoutSecs =
            Math.max(
              config.inference.jobTimeoutSec,
              config.inference.fetchTimeoutSec,
            ) + 10;
        }
        break;
      case "embedding": {
        if (data.type === "delete" || !b) {
          input = { operation: "vectorDelete", bookmarkId: data.bookmarkId };
          break;
        }
        if (data.type === "index") {
          input = {
            operation: "vectorIndex",
            bookmarkId: b.id,
            userId: b.userId,
            embedding: data.embedding,
          };
          break;
        }
        if (
          (!config.embedding.enableAutoIndexing && !data.force) ||
          !config.embedding.isConfigured
        )
          break;
        const text = await plainText(b);
        const parts = [
          `Title: ${b.title ?? b.link?.title ?? ""}`,
          `Type: ${b.type}`,
          `Tags: ${b.tagsOnBookmarks
            .map((t) => t.tag.name)
            .sort()
            .join(", ")}`,
          `Summary: ${b.summary ?? ""}`,
          `Note: ${b.note ?? ""}`,
          `URL: ${b.link?.url ?? b.text?.sourceUrl ?? b.asset?.sourceUrl ?? ""}`,
          `Description: ${b.link?.description ?? ""}`,
          `Author: ${b.link?.author ?? ""}`,
          `Publisher: ${b.link?.publisher ?? ""}`,
          `File name: ${b.asset?.fileName ?? ""}`,
          `Content excerpt: ${text.replace(/\s+/g, " ").slice(0, 3000)}`,
        ];
        input = {
          operation: "embedding",
          text: parts.join("\n\n").slice(0, config.embedding.contextLength),
          model: config.embedding.textModel,
          dimensions: config.embedding.dimensions,
          dimensionOverride: config.embedding.textModelDimensionOverride,
        };
        timeoutSecs = config.embedding.jobTimeoutSec;
        break;
      }
      case "publish": {
        if (!b)
          input = { operation: "searchDelete", bookmarkId: data.bookmarkId };
        else
          input = {
            operation: "searchIndex",
            document: {
              id: b.id,
              userId: b.userId,
              url: b.link?.url,
              linkTitle: b.link?.title,
              description: b.link?.description,
              content: await plainText(b),
              publisher: b.link?.publisher,
              author: b.link?.author,
              datePublished: b.link?.datePublished,
              dateModified: b.link?.dateModified,
              note: b.note,
              summary: b.summary,
              title: b.title,
              createdAt: b.createdAt.toISOString(),
              tags: b.tagsOnBookmarks.map((t) => t.tag.name),
            },
          };
        timeoutSecs = Math.max(config.search.jobTimeoutSec, 120);
        break;
      }
      case "webhook": {
        const userId = data.userId ?? b?.userId;
        const rows = ledger.sqlite
          .prepare("SELECT * FROM webhooks WHERE userId=?")
          .all(userId ?? "") as {
          id: string;
          url: string;
          token: string | null;
          events: string;
        }[];
        input = {
          operation: "webhook",
          deliveries: rows
            .filter((w) => JSON.parse(w.events).includes(data.operation))
            .map((w) => ({
              id: w.id,
              url: w.url,
              token: w.token,
              body: {
                jobId: job.id,
                bookmarkId: data.bookmarkId,
                userId,
                url: b?.link?.url,
                type: b?.type,
                operation: data.operation,
              },
            })),
          timeoutSecs: config.webhook.timeoutSec,
        };
        break;
      }
      case "feed": {
        const feed = ledger.sqlite
          .prepare("SELECT * FROM rssFeeds WHERE id=? AND enabled=1")
          .get(data.feedId) as { url: string } | undefined;
        if (feed) input = { operation: "feed", url: feed.url };
        break;
      }
      case "video": {
        if (
          !b?.link ||
          !(data.onDemand
            ? config.crawler.downloadVideoOnDemand
            : config.crawler.downloadVideo)
        )
          break;
        input = {
          operation: "video",
          url: b.link.url,
          maxSizeMb: config.crawler.maxVideoDownloadSize,
          args: config.crawler.ytDlpArguments,
        };
        timeoutSecs = config.crawler.downloadVideoTimeout;
        break;
      }
      case "export":
        input = await prepareExport(job, dir);
        timeoutSecs = 600;
        break;
      case "rules":
      case "import":
      case "maintenance":
        input = { operation: "domain" };
        timeoutSecs = 600;
        break;
      default:
        throw new Error(`Unsupported work kind: ${job.kind}`);
    }
  // A checkpoint from a previous input generation must never be replayed.
  const checkpoint =
    job.fingerprint === current && job.checkpoint
      ? JSON.parse(job.checkpoint)
      : null;
  ledger.sqlite
    .prepare(
      "UPDATE work_jobs SET fingerprint=?,checkpoint=? WHERE id=? AND token=? AND state='running'",
    )
    .run(
      current,
      checkpoint ? JSON.stringify(checkpoint) : null,
      job.id,
      job.token,
    );
  return {
    version: 1,
    id: job.id,
    token: job.token!,
    kind: job.kind,
    fingerprint: current,
    timeoutSecs,
    input,
    checkpoint,
    workDir: dir,
  };
}
