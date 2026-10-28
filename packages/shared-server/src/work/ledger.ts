import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type Database from "better-sqlite3";

export interface WorkJob {
  id: string;
  kind: string;
  payload: string;
  subject: string | null;
  state: "pending" | "running" | "completed" | "failed" | "obsolete";
  dedupeKey: string;
  priority: number;
  availableAt: number;
  attempts: number;
  maxAttempts: number;
  token: string | null;
  leaseUntil: number | null;
  fingerprint: string | null;
  checkpoint: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/** All methods are synchronous: callers can include them in domain transactions. */
export class WorkLedger {
  readonly events = new EventEmitter();
  constructor(readonly sqlite: Database.Database) {
    this.events.setMaxListeners(32);
  }

  enqueue(
    kind: string,
    data: Record<string, unknown>,
    options: {
      idempotencyKey?: string;
      priority?: number;
      delayMs?: number;
      maxAttempts?: number;
      subject?: string;
    } = {},
  ): string {
    const now = Date.now();
    const key =
      kind === "publish"
        ? `publish:${data.bookmarkId}`
        : `${kind}:${kind === "ingest" ? digest(data) : (options.idempotencyKey ?? digest(data))}`;
    const subject =
      options.subject ??
      (typeof data.bookmarkId === "string"
        ? data.bookmarkId
        : typeof data.feedId === "string"
          ? `feed:${data.feedId}`
          : typeof data.importSessionId === "string"
            ? `import:${data.importSessionId}`
            : kind === "export" && typeof data.userId === "string"
              ? `export:${data.userId}`
              : null);
    const row = this.sqlite
      .prepare(`
      INSERT INTO work_jobs
        (id,kind,payload,subject,dedupeKey,priority,availableAt,maxAttempts,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(dedupeKey) WHERE state='pending' DO UPDATE SET
        payload=excluded.payload, priority=min(priority,excluded.priority),
        availableAt=min(availableAt,excluded.availableAt),updatedAt=excluded.updatedAt
      RETURNING id
    `)
      .get(
        randomUUID(),
        kind,
        stableJson(data),
        subject,
        key,
        options.priority ?? 0,
        now + (options.delayMs ?? 0),
        options.maxAttempts ?? 5,
        now,
        now,
      ) as { id: string };
    // Notifications are hints. A transaction may still roll back after this call.
    queueMicrotask(() => this.events.emit("work"));
    return row.id;
  }

  claim(kinds: string[], leaseMs = 120_000): WorkJob | undefined {
    if (kinds.length === 0) return undefined;
    const now = Date.now();
    return this.sqlite
      .transaction(() => {
        const expired = this.sqlite
          .prepare(
            "SELECT * FROM work_jobs WHERE state='running' AND leaseUntil<?",
          )
          .all(now) as WorkJob[];
        for (const job of expired) {
          const newer = this.sqlite
            .prepare(
              "SELECT id FROM work_jobs WHERE dedupeKey=? AND state='pending'",
            )
            .get(job.dedupeKey);
          this.sqlite
            .prepare(
              `UPDATE work_jobs SET state=?,token=NULL,leaseUntil=NULL,updatedAt=? WHERE id=?`,
            )
            .run(
              newer
                ? "obsolete"
                : job.attempts >= job.maxAttempts
                  ? "failed"
                  : "pending",
              now,
              job.id,
            );
          if (!newer && job.attempts >= job.maxAttempts)
            this.events.emit("exhausted", this.get(job.id));
        }
        const row = this.sqlite
          .prepare(`SELECT j.* FROM work_jobs j
        WHERE j.state='pending' AND j.availableAt<=?
          AND j.kind IN (${kinds.map(() => "?").join(",")})
          AND (j.subject IS NULL OR NOT EXISTS
            (SELECT 1 FROM work_jobs r WHERE r.state='running' AND r.subject=j.subject))
        ORDER BY j.priority,j.availableAt,j.createdAt,j.id LIMIT 1
      `)
          .get(now, ...kinds) as WorkJob | undefined;
        if (!row) return undefined;
        const token = randomUUID();
        this.sqlite
          .prepare(`UPDATE work_jobs SET state='running',token=?,leaseUntil=?,
        attempts=attempts+1,updatedAt=? WHERE id=?`)
          .run(token, now + leaseMs, now, row.id);
        return {
          ...row,
          state: "running" as const,
          token,
          leaseUntil: now + leaseMs,
          attempts: row.attempts + 1,
          updatedAt: now,
        };
      })
      .immediate();
  }

  get(id: string): WorkJob | undefined {
    return this.sqlite.prepare("SELECT * FROM work_jobs WHERE id=?").get(id) as
      | WorkJob
      | undefined;
  }

  active(id: string, token: string): WorkJob | undefined {
    const row = this.get(id);
    return row?.state === "running" &&
      row.token === token &&
      (row.leaseUntil ?? 0) > Date.now()
      ? row
      : undefined;
  }

  renew(id: string, token: string, leaseMs = 120_000): boolean {
    const now = Date.now();
    return (
      this.sqlite
        .prepare(`UPDATE work_jobs SET leaseUntil=?,updatedAt=?
      WHERE id=? AND token=? AND state='running' AND leaseUntil>?`)
        .run(now + leaseMs, now, id, token, now).changes === 1
    );
  }

  checkpoint(id: string, token: string, value: unknown): boolean {
    return (
      this.sqlite
        .prepare(`UPDATE work_jobs SET checkpoint=?,updatedAt=?
      WHERE id=? AND token=? AND state='running' AND leaseUntil>?`)
        .run(stableJson(value), Date.now(), id, token, Date.now()).changes === 1
    );
  }

  finish(
    id: string,
    token: string,
    state: "completed" | "obsolete" = "completed",
  ): boolean {
    return (
      this.sqlite
        .prepare(`UPDATE work_jobs SET state=?,leaseUntil=NULL,updatedAt=?
      WHERE id=? AND token=? AND state='running' AND leaseUntil>?`)
        .run(state, Date.now(), id, token, Date.now()).changes === 1
    );
  }

  fail(
    id: string,
    token: string,
    message: string,
    retryAfterMs?: number,
  ): WorkJob | undefined {
    const row = this.active(id, token);
    if (!row) return undefined;
    if (
      this.sqlite
        .prepare(
          "SELECT id FROM work_jobs WHERE dedupeKey=? AND state='pending'",
        )
        .get(row.dedupeKey)
    ) {
      this.finish(id, token, "obsolete");
      return this.get(id);
    }
    const retry = row.attempts < row.maxAttempts;
    const delay =
      retryAfterMs ?? Math.min(300_000, 1000 * 2 ** (row.attempts - 1));
    this.sqlite
      .prepare(`UPDATE work_jobs SET state=?,token=NULL,leaseUntil=NULL,
      availableAt=?,updatedAt=?,error=? WHERE id=? AND token=?`)
      .run(
        retry ? "pending" : "failed",
        Date.now() + delay,
        Date.now(),
        message.slice(0, 2000),
        id,
        token,
      );
    return this.get(id);
  }

  stats(kind: string) {
    const rows = this.sqlite
      .prepare(`SELECT CASE WHEN state='pending' AND attempts>0 THEN 'pending_retry' ELSE state END state,count(*) n FROM work_jobs
      WHERE kind=? GROUP BY 1`)
      .all(kind) as { state: string; n: number }[];
    const counts = Object.fromEntries(rows.map((r) => [r.state, r.n]));
    return {
      pending: counts.pending ?? 0,
      pending_retry: counts.pending_retry ?? 0,
      running: counts.running ?? 0,
      failed: counts.failed ?? 0,
      completed: counts.completed ?? 0,
    };
  }

  nextDelay(): number {
    const row = this.sqlite
      .prepare(`SELECT min(t) t FROM
      (SELECT min(availableAt) t FROM work_jobs j WHERE state='pending'
       AND (subject IS NULL OR NOT EXISTS(SELECT 1 FROM work_jobs r WHERE r.state='running' AND r.subject=j.subject))
       UNION ALL SELECT min(leaseUntil) t FROM work_jobs WHERE state='running')`)
      .get() as { t: number | null };
    return Math.max(
      100,
      Math.min(30_000, (row.t ?? Date.now() + 30_000) - Date.now()),
    );
  }

  async wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.events.off("work", done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.events.once("work", done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}
