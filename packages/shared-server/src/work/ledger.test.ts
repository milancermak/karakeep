import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkLedger } from "./ledger";

let sqlite: Database.Database;
let ledger: WorkLedger;
beforeEach(() => {
  sqlite = new Database(":memory:");
  const migration = readFileSync(
    new URL("../../../db/drizzle/0096_rust_engine.sql", import.meta.url),
    "utf8",
  );
  for (const sql of migration.split("--> statement-breakpoint")) {
    if (!sql.trim().startsWith("CREATE TRIGGER")) sqlite.exec(sql);
  }
  ledger = new WorkLedger(sqlite);
});
afterEach(() => {
  sqlite.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("durable work ledger", () => {
  it("commits domain data and work together, and rolls back both", () => {
    sqlite.exec("CREATE TABLE domain(id TEXT PRIMARY KEY)");
    expect(() =>
      sqlite.transaction(() => {
        sqlite.prepare("INSERT INTO domain VALUES ('example')").run();
        ledger.enqueue("ai", { bookmarkId: "example" });
        throw new Error("crash before commit");
      })(),
    ).toThrow();
    expect(sqlite.prepare("SELECT * FROM domain").all()).toEqual([]);
    expect(ledger.claim(["ai"])).toBeUndefined();
    sqlite.transaction(() => {
      sqlite.prepare("INSERT INTO domain VALUES ('example')").run();
      ledger.enqueue("ai", { bookmarkId: "example" });
    })();
    expect(ledger.claim(["ai"])?.subject).toBe("example");
  });
  it("coalesces publication to the latest state without losing changes during a run", () => {
    const id = ledger.enqueue("publish", { bookmarkId: "a", type: "index" });
    expect(ledger.enqueue("publish", { bookmarkId: "a", type: "delete" })).toBe(
      id,
    );
    const first = ledger.claim(["publish"])!;
    expect(JSON.parse(first.payload).type).toBe("delete");
    const next = ledger.enqueue("publish", { bookmarkId: "a", type: "index" });
    expect(next).not.toBe(id);
    expect(ledger.claim(["publish"])).toBeUndefined();
    ledger.finish(id, first.token!);
    expect(ledger.claim(["publish"])?.id).toBe(next);
  });
  it("recovers expired leases, rejects fenced completions, and retains checkpoints", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const id = ledger.enqueue("embedding", { bookmarkId: "a" });
    const first = ledger.claim(["embedding"], 100)!;
    ledger.checkpoint(id, first.token!, { result: { embedding: [1, 2, 3] } });
    vi.spyOn(Date, "now").mockReturnValue(1101);
    const second = ledger.claim(["embedding"], 100)!;
    expect(second.token).not.toBe(first.token);
    expect(JSON.parse(second.checkpoint!)).toEqual({
      result: { embedding: [1, 2, 3] },
    });
    expect(ledger.finish(id, first.token!)).toBe(false);
    expect(ledger.finish(id, second.token!)).toBe(true);
  });
  it("handles a pending successor when an active attempt fails or expires", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    ledger.enqueue("publish", { bookmarkId: "a", type: "index" });
    const first = ledger.claim(["publish"], 100)!;
    const successor = ledger.enqueue("publish", {
      bookmarkId: "a",
      type: "delete",
    });
    expect(() =>
      ledger.fail(first.id, first.token!, "network unavailable"),
    ).not.toThrow();
    expect(ledger.get(first.id)?.state).toBe("obsolete");
    expect(ledger.claim(["publish"])?.id).toBe(successor);
  });
  it("makes delayed work durable and stops retrying exhausted attempts", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const id = ledger.enqueue(
      "feed",
      { feedId: "feed" },
      { delayMs: 1000, maxAttempts: 1 },
    );
    expect(ledger.claim(["feed"])).toBeUndefined();
    vi.spyOn(Date, "now").mockReturnValue(2000);
    const job = new WorkLedger(sqlite).claim(["feed"])!;
    ledger.fail(id, job.token!, "failed");
    expect(ledger.get(id)?.state).toBe("failed");
  });
});
