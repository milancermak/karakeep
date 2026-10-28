import { z } from "zod";

export const WORK_PROTOCOL_VERSION = 1;
export const workRequestSchema = z.object({
  version: z.literal(WORK_PROTOCOL_VERSION),
  method: z.enum([
    "claim",
    "renew",
    "checkpoint",
    "complete",
    "fail",
    "validate",
    "health",
  ]),
  params: z.record(z.string(), z.unknown()),
});
export const receiptSchema = z.object({
  id: z.string().min(1),
  token: z.string().min(1),
});
export const claimSchema = z.object({
  kinds: z
    .array(
      z.enum([
        "ingest",
        "asset",
        "ai",
        "embedding",
        "publish",
        "feed",
        "video",
        "webhook",
        "export",
        "import",
        "rules",
        "maintenance",
      ]),
    )
    .min(1)
    .max(12),
  waitMs: z.number().int().min(0).max(30_000).default(30_000),
});
export const artifactSchema = z.object({
  path: z.string().min(1),
  role: z.enum([
    "linkRawHtml",
    "linkHtmlContent",
    "linkScreenshot",
    "linkPdf",
    "linkBannerImage",
    "linkFullPageArchive",
    "linkVideo",
    "bookmarkAsset",
    "assetScreenshot",
    "backup",
  ]),
  contentType: z.string().min(1),
  fileName: z.string().nullable().optional(),
});
export const documentResultSchema = z.object({
  kind: z.literal("document"),
  sourceUrl: z.string().optional(),
  statusCode: z.number().int().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  assessment: z
    .object({
      status: z.enum(["readable", "not_readable", "uncertain", "unavailable"]),
      score: z.number().int(),
      reasons: z.array(z.string()),
      classifierVersion: z.number().int(),
    })
    .nullable()
    .optional(),
  plainTextPath: z.string(),
  artifacts: z.array(artifactSchema),
  assetType: z.enum(["image", "pdf"]).optional(),
});
export const resultSchema = z.discriminatedUnion("kind", [
  documentResultSchema,
  z.object({
    kind: z.literal("tags"),
    tags: z.array(z.string()).max(100),
    usage: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal("summary"),
    summary: z.string(),
    usage: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal("embedding"),
    embedding: z.array(z.number()),
    usage: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal("feed"),
    items: z.array(
      z.object({
        guid: z.string(),
        link: z.string(),
        title: z.string().optional(),
        categories: z.array(z.string()).default([]),
      }),
    ),
  }),
  z.object({
    kind: z.literal("artifacts"),
    artifacts: z.array(artifactSchema),
    bookmarkCount: z.number().int().optional(),
  }),
  z.object({ kind: z.literal("done"), skipped: z.boolean().optional() }),
]);
export type WorkResult = z.infer<typeof resultSchema>;
export const preparedWorkSchema = z.object({
  version: z.literal(WORK_PROTOCOL_VERSION),
  id: z.string(),
  token: z.string(),
  kind: z.string(),
  fingerprint: z.string().nullable(),
  timeoutSecs: z.number().int().positive(),
  input: z.record(z.string(), z.unknown()),
  checkpoint: z.unknown(),
  workDir: z.string(),
});
export type PreparedWork = z.infer<typeof preparedWorkSchema>;
