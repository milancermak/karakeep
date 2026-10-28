import { db } from "@karakeep/db";
import { WorkLedger } from "./ledger";

export const rustEngineEnabled = () => process.env.KARAKEEP_ENGINE === "rust";

const globalWork = globalThis as typeof globalThis & {
  __karakeepWorkLedger?: WorkLedger;
};
export function workLedger(): WorkLedger {
  return (globalWork.__karakeepWorkLedger ??= new WorkLedger(db.$client));
}

export const queueKinds: Record<string, string> = {
  link_crawler_queue: "ingest",
  low_priority_crawler_queue: "ingest",
  openai_queue: "ai",
  embeddings_queue: "embedding",
  searching_indexing: "publish",
  admin_maintenance_queue: "maintenance",
  video_queue: "video",
  feed_queue: "feed",
  asset_preprocessing_queue: "asset",
  webhook_queue: "webhook",
  rule_engine_queue: "rules",
  backup_queue: "export",
};
