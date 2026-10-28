import { copyFile, lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@karakeep/db";
import type { KarakeepDBTransaction } from "@karakeep/db";
import { assets } from "@karakeep/db/schema";
import {
  QuotaService,
  saveAssetFromFile,
  zAssetMetadataSchema,
} from "@karakeep/shared-server";
import type { WorkJob } from "@karakeep/shared-server/work/ledger";
import type { artifactSchema } from "@karakeep/shared-server/work/contracts";
import type { z } from "zod";
import { stagingRoot } from "./prepare";

export function updateAsset(
  oldAssetId: string | undefined,
  newAsset: typeof assets.$inferInsert,
  tx: KarakeepDBTransaction,
) {
  if (oldAssetId) tx.delete(assets).where(eq(assets.id, oldAssetId)).run();
  tx.insert(assets).values(newAsset).run();
}

export async function checkedPath(job: WorkJob, file: string): Promise<string> {
  const root = path.join(stagingRoot(), job.id, job.token!);
  const candidate = path.resolve(root, file);
  if (!candidate.startsWith(root + path.sep))
    throw new Error("Artifact outside attempt directory");
  const [resolved, info] = await Promise.all([
    realpath(candidate),
    lstat(candidate),
  ]);
  if (resolved !== candidate || !info.isFile() || info.isSymbolicLink())
    throw new Error("Artifact must be a regular staged file");
  return candidate;
}

export interface PublishedAsset {
  id: string;
  role: z.infer<typeof artifactSchema>["role"];
  size: number;
  contentType: string;
  fileName: string | null;
}

export async function publishArtifacts(
  job: WorkJob,
  userId: string,
  items: z.infer<typeof artifactSchema>[],
): Promise<PublishedAsset[]> {
  const result: PublishedAsset[] = [];
  const paths = await Promise.all(
    items.map(async (item) => {
      const file = await checkedPath(job, item.path),
        info = await stat(file);
      if (info.size > 512 * 1024 * 1024)
        throw new Error("Artifact exceeds publication limit");
      return { item, file, size: info.size };
    }),
  );
  const quotaApproved = await QuotaService.checkStorageQuota(
    db,
    userId,
    paths.reduce((sum, p) => sum + p.size, 0),
  );
  for (const { item, file, size } of paths) {
    const id = `${job.id}-${item.role}`;
    const metadata = zAssetMetadataSchema.parse({
      contentType: item.contentType,
      fileName: item.fileName ?? null,
    });
    // Keep the original until completion is acknowledged, so a failed commit
    // can retry publication without redoing extraction or losing its input.
    const copy = file + ".publish";
    await copyFile(file, copy);
    await saveAssetFromFile({
      userId,
      assetId: id,
      assetPath: copy,
      metadata,
      quotaApproved,
    });
    result.push({
      id,
      role: item.role,
      size,
      contentType: item.contentType,
      fileName: item.fileName ?? null,
    });
  }
  return result;
}
