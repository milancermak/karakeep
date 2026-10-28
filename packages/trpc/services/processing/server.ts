import { createServer } from "node:http";
import type { Server } from "node:http";
import { chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import config from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";
import {
  workRequestSchema,
  claimSchema,
  receiptSchema,
  resultSchema,
  preparedWorkSchema,
} from "@karakeep/shared-server/work/contracts";
import {
  queueKinds,
  rustEngineEnabled,
  workLedger,
} from "@karakeep/shared-server/work/runtime";
import { processDomainEvent, snapshot, fingerprint } from "./model";
import { prepareJob, stagingRoot } from "./prepare";
import { completeJob, markFailure } from "./apply";

const serviceGlobal = globalThis as typeof globalThis & {
  __karakeepWorkServer?: Server;
};
const completions = new Map<string, Promise<boolean>>();

function migrateLegacyQueue() {
  const ledger = workLedger();
  const file = path.resolve(config.dataDir || ".", "queue.db");
  let old: Database.Database;
  try {
    old = new Database(file, { readonly: true, fileMustExist: true });
  } catch {
    return;
  }
  try {
    const tasks = old
      .prepare(
        "SELECT id,queue,payload,priority,availableAt,maxNumRuns FROM tasks WHERE status IN ('pending','pending_retry','running')",
      )
      .all() as {
      id: number;
      queue: string;
      payload: string;
      priority: number;
      availableAt: number;
      maxNumRuns: number;
    }[];
    ledger.sqlite
      .transaction(() => {
        for (const task of tasks) {
          const key = `legacy:${task.id}`;
          if (
            ledger.sqlite
              .prepare("SELECT 1 FROM work_settings WHERE key=?")
              .get(key)
          )
            continue;
          const kind = queueKinds[task.queue];
          if (!kind)
            throw new Error(
              `Cannot migrate unknown legacy queue ${task.queue}`,
            );
          ledger.enqueue(kind, JSON.parse(task.payload), {
            priority: task.priority,
            delayMs: Math.max(0, task.availableAt - Date.now()),
            maxAttempts: task.maxNumRuns,
            idempotencyKey: key,
          });
          ledger.sqlite
            .prepare(
              "INSERT INTO work_settings(key,value) VALUES (?,'migrated')",
            )
            .run(key);
        }
      })
      .immediate();
    if (tasks.length)
      logger.info(`[engine] Migrated ${tasks.length} outstanding legacy jobs`);
  } finally {
    old.close();
  }
}

function seedScheduledWork() {
  const ledger = workLedger();
  const feeds = ledger.sqlite
    .prepare("SELECT id,lastFetchedAt FROM rssFeeds WHERE enabled=1")
    .all() as { id: string; lastFetchedAt: number | null }[];
  for (const feed of feeds)
    ledger.enqueue(
      "feed",
      { feedId: feed.id },
      {
        delayMs: Math.max(
          0,
          (feed.lastFetchedAt ?? 0) * 1000 + 3600_000 - Date.now(),
        ),
        subject: `feed:${feed.id}`,
      },
    );
  const users = ledger.sqlite
    .prepare("SELECT id,backupsFrequency FROM user WHERE backupsEnabled=1")
    .all() as { id: string; backupsFrequency: string }[];
  for (const user of users) {
    const last = ledger.sqlite
      .prepare(
        "SELECT max(createdAt) t FROM backups WHERE userId=? AND status='success'",
      )
      .get(user.id) as { t: number | null };
    const interval =
      user.backupsFrequency === "daily" ? 86400_000 : 7 * 86400_000;
    ledger.enqueue(
      "export",
      { userId: user.id },
      {
        delayMs: Math.max(0, (last.t ?? 0) * 1000 + interval - Date.now()),
        subject: `export:${user.id}`,
      },
    );
  }
  const imports = ledger.sqlite
    .prepare(
      "SELECT id FROM importSessions WHERE status IN ('pending','running')",
    )
    .all() as { id: string }[];
  for (const item of imports)
    ledger.enqueue(
      "import",
      { importSessionId: item.id },
      { subject: `import:${item.id}`, priority: 50 },
    );
  ledger.enqueue(
    "maintenance",
    { type: "engine_cleanup" },
    { delayMs: 86400_000 },
  );
}

async function dispatch(
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const ledger = workLedger();
  if (method === "health") return { version: 1 };
  if (method === "claim") {
    const { kinds, waitMs } = claimSchema.parse(params),
      until = Date.now() + waitMs;
    do {
      // Domain events execute in the application; they never load an execution
      // SDK or escape to a separate Node worker.
      for (let n = 0; n < 32; n++) {
        const event = ledger.claim(["domain"]);
        if (!event) break;
        try {
          await processDomainEvent(event);
          if (ledger.active(event.id, event.token!))
            ledger.finish(event.id, event.token!);
        } catch (e) {
          ledger.fail(
            event.id,
            event.token!,
            e instanceof Error ? e.message : "Domain event failed",
          );
        }
      }
      const job = ledger.claim(kinds);
      if (job) {
        const renew = setInterval(
          () => ledger.renew(job.id, job.token!),
          30_000,
        );
        renew.unref();
        try {
          const prepared = await prepareJob(job);
          if (signal.aborted) {
            ledger.fail(job.id, job.token!, "Claim disconnected", 100);
            return null;
          }
          return preparedWorkSchema.parse(prepared);
        } catch (e) {
          const failed = ledger.fail(
            job.id,
            job.token!,
            e instanceof Error ? e.message : "Job preparation failed",
          );
          if (failed) markFailure(failed);
          // Preserve forward progress when an individual job cannot prepare.
          if (waitMs === 0) return null;
          continue;
        } finally {
          clearInterval(renew);
        }
      }
      if (signal.aborted || Date.now() >= until) return null;
      await ledger.wait(
        Math.min(ledger.nextDelay(), until - Date.now()),
        signal,
      );
    } while (!signal.aborted);
    return null;
  }
  const { id, token } = receiptSchema.parse(params);
  const job = ledger.get(id);
  if (method === "renew") return ledger.renew(id, token);
  if (method === "checkpoint") {
    const value = z.record(z.string(), z.unknown()).parse(params.value);
    return ledger.sqlite
      .transaction(() => {
        if (!ledger.checkpoint(id, token, value)) return false;
        if (job?.kind === "ingest" && value.probe && job.fingerprint) {
          const data = JSON.parse(job.payload),
            b = snapshot(data.bookmarkId);
          if (b && fingerprint(b) === job.fingerprint) {
            const metadata = z
              .record(z.string(), z.unknown())
              .parse(value.probe);
            for (const [field, column] of [
              ["title", "title"],
              ["description", "description"],
              ["author", "author"],
              ["publisher", "publisher"],
              ["image", "imageUrl"],
              ["logo", "favicon"],
            ]) {
              const text =
                typeof metadata[field] === "string" ? metadata[field] : null;
              ledger.sqlite
                .prepare(
                  `UPDATE bookmarkLinks SET ${column}=coalesce(${column},?) WHERE id=?`,
                )
                .run(text, b.id);
            }
            ledger.sqlite
              .prepare(
                "UPDATE bookmarkLinks SET probeMetadataAt=unixepoch() WHERE id=?",
              )
              .run(b.id);
          }
        }
        return true;
      })
      .immediate();
  }
  if (method === "validate") {
    if (!ledger.active(id, token)) return false;
    if (!job?.fingerprint) return true;
    const data = JSON.parse(job.payload),
      b =
        typeof data.bookmarkId === "string"
          ? snapshot(data.bookmarkId)
          : undefined;
    return !!b && fingerprint(b) === job.fingerprint;
  }
  if (method === "complete") {
    // Lost acknowledgement: retrying completion is successful without reapplying.
    if (job?.token === token && ["completed", "obsolete"].includes(job.state))
      return true;
    if (!ledger.active(id, token) || !job) return false;
    const result = resultSchema.parse(params.result);
    let pending = completions.get(id);
    if (!pending) {
      pending = completeJob(job, result).finally(() => completions.delete(id));
      completions.set(id, pending);
    }
    return pending;
  }
  if (method === "fail") {
    const error = z.string().max(2000).parse(params.error);
    const failed = ledger.fail(
      id,
      token,
      error,
      typeof params.retryAfterMs === "number" ? params.retryAfterMs : undefined,
    );
    if (failed) markFailure(failed);
    return !!failed;
  }
  throw new Error("Unknown work method");
}

export async function startWorkService(): Promise<void> {
  if (serviceGlobal.__karakeepWorkServer) return;
  const ledger = workLedger();
  ledger.events.on("exhausted", markFailure);
  ledger.sqlite
    .prepare("UPDATE work_settings SET value=? WHERE key='enabled'")
    .run(rustEngineEnabled() ? "1" : "0");
  if (!rustEngineEnabled()) return;
  migrateLegacyQueue();
  seedScheduledWork();
  await mkdir(stagingRoot(), { recursive: true, mode: 0o700 });
  const socket =
    process.env.KARAKEEP_WORK_SOCKET ??
    path.resolve(config.dataDir || ".", "engine.sock");
  await mkdir(path.dirname(socket), { recursive: true, mode: 0o700 });
  await rm(socket, { force: true });
  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    res.setHeader("Content-Type", "application/json");
    if (req.method !== "POST" || req.url !== "/v1/work") {
      res.writeHead(404).end();
      return;
    }
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw new Error("Work request too large");
        chunks.push(Buffer.from(chunk));
      }
      const request = workRequestSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      const result = await dispatch(
        request.method,
        request.params,
        abort.signal,
      );
      res.end(JSON.stringify({ version: 1, result }));
    } catch (e) {
      logger.error(
        `[engine] Work request failed: ${e instanceof Error ? e.message : "Unknown error"}`,
      );
      res
        .writeHead(400)
        .end(JSON.stringify({ version: 1, error: "Work request failed" }));
    }
  });
  server.requestTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  await chmod(socket, 0o600);
  serviceGlobal.__karakeepWorkServer = server;
  logger.info("[engine] Private work service ready (protocol 1)");
}
