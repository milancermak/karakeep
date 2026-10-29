import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { assert, beforeEach, describe, expect, inject, it } from "vitest";
import { createKarakeepClient } from "@karakeep/sdk";
import { createTestUser } from "../../utils/api";
import { waitUntil } from "../../utils/general";
import { getTrpcClient } from "../../utils/trpc";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
function inside(script: string): unknown {
  const output = execFileSync(
    "docker",
    ["compose", "exec", "-T", "web", "node", "-e", script],
    { cwd: root, encoding: "utf8" },
  );
  return output.trim() ? JSON.parse(output) : null;
}
const database = `const Database=require('/app/apps/workers/node_modules/better-sqlite3');const db=new Database(process.env.DATA_DIR+'/db.db');db.pragma('foreign_keys=ON');`;
function query(sql: string, args: unknown[] = []): unknown {
  return inside(
    database +
      `console.log(JSON.stringify(db.prepare(${JSON.stringify(sql)}).all(...${JSON.stringify(args)})));`,
  );
}
function run(sql: string, args: unknown[] = []): void {
  inside(
    database +
      `db.prepare(${JSON.stringify(sql)}).run(...${JSON.stringify(args)});`,
  );
}
function rpc(method: string, params: unknown): unknown {
  return inside(`const http=require('node:http');const body=JSON.stringify(${JSON.stringify({ version: 1, method, params })});
    const request=http.request({socketPath:process.env.DATA_DIR+'/engine.sock',method:'POST',path:'/v1/work',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},response=>{
      let data='';response.on('data',chunk=>data+=chunk);response.on('end',()=>{const value=JSON.parse(data);if(value.error)throw new Error(value.error);console.log(JSON.stringify(value.result));});});request.on('error',error=>{throw error;});request.end(body);`);
}
function pauseEngine(pause: boolean): void {
  inside(`const {execFileSync}=require('node:child_process');
    execFileSync('/command/s6-svc',[${JSON.stringify(pause ? "-d" : "-u")},'/run/service/svc-workers']);
    ${pause ? "execFileSync('/command/s6-svwait',['-d','-t','15000','/run/service/svc-workers']);" : ""}`);
}

describe("Rust engine contract", () => {
  const port = inject("karakeepPort");
  let client: ReturnType<typeof createKarakeepClient>;
  let api: ReturnType<typeof getTrpcClient>;
  beforeEach(async () => {
    const key = await createTestUser();
    api = getTrpcClient(key);
    await api.users.updateSettings.mutate({
      autoTaggingEnabled: true,
    });
    client = createKarakeepClient({
      baseUrl: `http://localhost:${port}/api/v1/`,
      headers: { authorization: `Bearer ${key}` },
    });
  });
  async function textBookmark() {
    const { data } = await client.POST("/bookmarks", {
      body: { type: "text", text: "A text document about Rust and SQLite." },
    });
    assert(data);
    await waitUntil(
      async () => {
        const { data: b } = await client.GET("/bookmarks/{bookmarkId}", {
          params: { path: { bookmarkId: data.id } },
        });
        return b?.taggingStatus === "success";
      },
      "Text processing completes",
      120000,
    );
    await waitUntil(
      async () => {
        const rows = query(
          "SELECT count(*) n FROM work_jobs WHERE subject=? AND state IN ('pending','running')",
          [data.id],
        ) as { n: number }[];
        return rows[0].n === 0;
      },
      "Bookmark work settles",
      120000,
    );
    return data;
  }
  function claimTag(bookmarkId: string, expectedFingerprint?: string) {
    const id = randomUUID(),
      now = Date.now();
    run(
      `INSERT INTO work_jobs(id,kind,payload,subject,dedupeKey,priority,availableAt,createdAt,updatedAt)
      VALUES (?,'ai',?,?,?,-100,?,?,?)`,
      [
        id,
        JSON.stringify({ bookmarkId, type: "tag", expectedFingerprint }),
        bookmarkId,
        id,
        now,
        now,
        now,
      ],
    );
    const job = rpc("claim", { kinds: ["ai"], waitMs: 0 }) as {
      id: string;
      token: string;
    };
    expect(job.id).toBe(id);
    return job;
  }

  it("runs without the permanent Node worker and shares extracted text with search", async () => {
    const bookmark = await textBookmark();
    expect(
      query("SELECT plainText FROM extracted_documents WHERE bookmarkId=?", [
        bookmark.id,
      ]),
    ).toEqual([{ plainText: "A text document about Rust and SQLite." }]);
    const workers = inside(String.raw`const fs=require('node:fs');let count=0;
      for(const id of fs.readdirSync('/proc').filter(s=>Number.isInteger(Number(s)))){try{
        const args=fs.readFileSync('/proc/'+id+'/cmdline','utf8').split(String.fromCharCode(0));
        if(args[1]==='dist/index.js')count++;}catch{}}console.log(count);`);
    expect(workers).toBe(0);
  }, 180000);

  it("refreshes retrieval for descriptive metadata and notes without repeating extraction or tagging", async () => {
    const bookmark = await textBookmark();
    const params = { path: { bookmarkId: bookmark.id } };
    async function settle() {
      await waitUntil(
        async () => {
          const [row] = query(
            "SELECT count(*) n FROM work_jobs WHERE subject=? AND state IN ('pending','running')",
            [bookmark.id],
          ) as { n: number }[];
          return row.n === 0;
        },
        "Metadata processing settles",
        120000,
      );
    }
    function counts() {
      return query(
        "SELECT kind,count(*) n FROM work_jobs WHERE subject=? GROUP BY kind ORDER BY kind",
        [bookmark.id],
      ) as { kind: string; n: number }[];
    }
    const initial = counts();
    const before = initial.find((row) => row.kind === "embedding")!.n;
    const metadata = {
      capture: { pageTitle: "QuasarNimbusHosting" },
      custom: { retained: [true, 2] },
    };
    // A direct DB mutation proves the durable outbox captures metadata changes
    // even without an application enqueue or a socket notification.
    run("UPDATE bookmarks SET metadata=? WHERE id=?", [
      JSON.stringify(metadata),
      bookmark.id,
    ]);
    await waitUntil(
      async () => {
        const { data } = await client.GET("/bookmarks/search", {
          params: { query: { q: "QuasarNimbusHosting", searchMode: "fts" } },
        });
        return data?.bookmarks.some((item) => item.id === bookmark.id) ?? false;
      },
      "Source metadata enters keyword search",
      120000,
    );
    await settle();
    expect(counts().find((row) => row.kind === "embedding")!.n).toBeGreaterThan(
      before,
    );
    const afterDescription = counts().find(
      (row) => row.kind === "embedding",
    )!.n;
    const { data: operationalPatch } = await client.PATCH(
      "/bookmarks/{bookmarkId}",
      {
        params,
        body: {
          metadata: {
            capture: { status: "complete" },
            custom: { hidden: "OperationalZephyrToken" },
          },
        },
      },
    );
    expect(operationalPatch?.metadata).toMatchObject(metadata);
    await settle();
    expect(counts().find((row) => row.kind === "embedding")!.n).toBe(
      afterDescription,
    );
    const { data: hiddenSearch } = await client.GET("/bookmarks/search", {
      params: { query: { q: "OperationalZephyrToken", searchMode: "fts" } },
    });
    expect(hiddenSearch?.bookmarks).toEqual([]);
    const { response } = await client.PATCH("/bookmarks/{bookmarkId}", {
      params,
      body: { note: "My new note about agent hosting" },
    });
    expect(response.status).toBe(200);
    await settle();
    expect(counts().find((row) => row.kind === "embedding")!.n).toBeGreaterThan(
      afterDescription,
    );
    expect(
      counts().filter((row) => ["ingest", "asset", "ai"].includes(row.kind)),
    ).toEqual(
      initial.filter((row) => ["ingest", "asset", "ai"].includes(row.kind)),
    );
    const [extracted] = query(
      "SELECT plainText,document FROM extracted_documents WHERE bookmarkId=?",
      [bookmark.id],
    ) as { plainText: string; document: string }[];
    expect(extracted.plainText).toBe("A text document about Rust and SQLite.");
    expect(JSON.parse(extracted.document).ownerContent.text).toBe(
      "My new note about agent hosting\n\n---\n\nA text document about Rust and SQLite.",
    );
  }, 180000);

  it("applies rules without recursively firing rules for their own tag actions", async () => {
    const tag = await api.tags.create.mutate({ name: "Added by a rule" });
    await api.rules.create.mutate({
      name: "Tag newly saved items",
      description: null,
      event: { type: "bookmarkAdded" },
      condition: { type: "alwaysTrue" },
      actions: [
        { type: "addTag", tagId: tag.id },
        { type: "favouriteBookmark" },
      ],
      enabled: true,
    });
    await api.rules.create.mutate({
      name: "Only react to external tag changes",
      description: null,
      event: { type: "tagAdded", tagId: tag.id },
      condition: { type: "alwaysTrue" },
      actions: [{ type: "removeTag", tagId: tag.id }],
      enabled: true,
    });
    const bookmark = await textBookmark();
    const { data } = await client.GET("/bookmarks/{bookmarkId}", {
      params: { path: { bookmarkId: bookmark.id } },
    });
    assert(data);
    expect(data.favourited).toBe(true);
    expect(data.tags.find((t) => t.id === tag.id)?.attachedBy).toBe("human");
  }, 180000);

  it("processes a committed bookmark without any JavaScript enqueue or notification", async () => {
    const owner = await textBookmark();
    const id = randomUUID();
    inside(
      database +
        `db.transaction(()=>{
      const owner=db.prepare('SELECT userId FROM bookmarks WHERE id=?').get(${JSON.stringify(owner.id)});
      db.prepare("INSERT INTO bookmarks(id,userId,type,createdAt,lastSavedAt,taggingStatus,summarizationStatus,embeddingStatus) VALUES (?,?,'text',unixepoch(),unixepoch(),'pending','pending','pending')").run(${JSON.stringify(id)},owner.userId);
      db.prepare('INSERT INTO bookmarkTexts(id,text) VALUES (?,?)').run(${JSON.stringify(id)},'Durable intent survives a missing notification.');
    })();`,
    );
    await waitUntil(
      async () => {
        const { data } = await client.GET("/bookmarks/{bookmarkId}", {
          params: { path: { bookmarkId: id } },
        });
        return data?.taggingStatus === "success";
      },
      "Committed mutation is recovered without a notification",
      120000,
    );
  }, 180000);

  // Fault injection stops the shared executor. Run these tests separately from
  // parallel compatibility tests so their leased work is not interrupted.
  it.runIf(process.env.KARAKEEP_ENGINE_FAULT_TESTS === "1")(
    "preserves a human title against a late AI result and isolates title failures from tagging",
    async () => {
      await api.users.updateSettings.mutate({ autoTaggingEnabled: false });
      pauseEngine(true);
      try {
        const { data: bookmark } = await client.POST("/bookmarks", {
          body: {
            type: "text",
            text: "Compare Rust and Node.js memory usage.",
            note: "Keep the comparison short",
            metadata: {
              capture: { pageTitle: "Source context" },
              x: { postId: "unindexed-id" },
            },
          },
        });
        assert(bookmark);
        const job = rpc("claim", { kinds: ["ai"], waitMs: 0 }) as {
          id: string;
          token: string;
          input: {
            operation: string;
            model: string;
            reasoningEffort: string;
            content: string;
          };
        };
        expect(job.input).toMatchObject({
          operation: "title",
          model: "gpt-6.1-terra",
          reasoningEffort: "none",
        });
        expect(job.input.content).toContain("Keep the comparison short");
        expect(job.input.content).toContain(
          "Compare Rust and Node.js memory usage",
        );
        expect(job.input.content).not.toContain("unindexed-id");
        await api.bookmarks.updateBookmark.mutate({
          bookmarkId: bookmark.id,
          title: "My manually supplied title",
        });
        expect(
          rpc("complete", {
            id: job.id,
            token: job.token,
            result: { kind: "title", title: "Late generated title" },
          }),
        ).toBe(true);
        expect(
          query("SELECT title FROM bookmarks WHERE id=?", [bookmark.id]),
        ).toEqual([{ title: "My manually supplied title" }]);
        expect(
          query("SELECT state FROM work_jobs WHERE id=?", [job.id]),
        ).toEqual([{ state: "obsolete" }]);

        // Simulate an embedding produced before the title changed. Its stale
        // tagging continuation must get one current successor, not disappear
        // or duplicate a successor that is already waiting.
        run(
          "UPDATE work_jobs SET state='completed' WHERE subject=? AND kind='embedding' AND state='pending'",
          [bookmark.id],
        );
        for (let attempt = 0; attempt < 2; attempt++) {
          const staleTag = claimTag(bookmark.id, "stale-title-context");
          expect(
            rpc("complete", {
              ...staleTag,
              result: { kind: "done", skipped: true },
            }),
          ).toBe(true);
          expect(
            query(
              "SELECT count(*) n FROM work_jobs WHERE subject=? AND kind='ai' AND state='pending' AND json_extract(payload,'$.type')='tag' AND json_extract(payload,'$.expectedFingerprint') IS NULL",
              [bookmark.id],
            ),
          ).toEqual([{ n: 1 }]);
        }

        const { data: failing } = await client.POST("/bookmarks", {
          body: {
            type: "text",
            text: "A synthetic note for a provider failure.",
          },
        });
        assert(failing);
        const failed = rpc("claim", { kinds: ["ai"], waitMs: 0 }) as {
          id: string;
          token: string;
          input: { operation: string };
        };
        expect(failed.input.operation).toBe("title");
        run("UPDATE work_jobs SET maxAttempts=1 WHERE id=?", [failed.id]);
        expect(
          rpc("fail", {
            id: failed.id,
            token: failed.token,
            error: "Synthetic title provider error",
          }),
        ).toBe(true);
        expect(
          query("SELECT title,taggingStatus FROM bookmarks WHERE id=?", [
            failing.id,
          ]),
        ).toEqual([{ title: null, taggingStatus: "pending" }]);
        expect(
          query("SELECT state FROM work_jobs WHERE id=?", [failed.id]),
        ).toEqual([{ state: "failed" }]);
      } finally {
        pauseEngine(false);
      }
    },
    180000,
  );

  it.runIf(process.env.KARAKEEP_ENGINE_FAULT_TESTS === "1")(
    "recovers a checkpointed result after the engine is killed and restarted",
    async () => {
      const bookmark = await textBookmark();
      pauseEngine(true);
      try {
        const job = claimTag(bookmark.id);
        expect(
          rpc("checkpoint", {
            ...job,
            value: {
              result: { kind: "tags", tags: ["recovered-checkpoint"] },
            },
          }),
        ).toBe(true);
        pauseEngine(false);
        await waitUntil(
          async () =>
            inside(String.raw`const fs=require('node:fs');console.log(fs.readdirSync('/proc').filter(s=>Number.isInteger(Number(s))).some(id=>{
        try{return fs.readFileSync('/proc/'+id+'/comm','utf8').trim()==='karakeep-engine';}catch{return false;}}));`) ===
            true,
          "Engine starts before fault injection",
          15000,
        );
        const killed = inside(
          database +
            String.raw`const fs=require('node:fs');let count=0;for(const id of fs.readdirSync('/proc').filter(s=>Number.isInteger(Number(s)))){
        try{if(fs.readFileSync('/proc/'+id+'/comm','utf8').trim()==='karakeep-engine'){process.kill(Number(id),'SIGKILL');count++;}}catch{}}
        db.prepare('UPDATE work_jobs SET leaseUntil=? WHERE id=?').run(Date.now()-1,${JSON.stringify(job.id)});console.log(count);`,
        );
        expect(killed).toBeGreaterThan(0);
        await waitUntil(
          async () => {
            const { data } = await client.GET("/bookmarks/{bookmarkId}", {
              params: { path: { bookmarkId: bookmark.id } },
            });
            return (
              data?.tags.some((t) => t.name === "recovered-checkpoint") ?? false
            );
          },
          "Restarted engine applies the durable checkpoint",
          120000,
        );
      } finally {
        pauseEngine(false);
      }
    },
    180000,
  );

  it.runIf(process.env.KARAKEEP_ENGINE_FAULT_TESTS === "1")(
    "rejects stale results, preserves human tags, and accepts completion replay",
    async () => {
      const bookmark = await textBookmark();
      const { response } = await client.POST("/bookmarks/{bookmarkId}/tags", {
        params: { path: { bookmarkId: bookmark.id } },
        body: { tags: [{ tagName: "Manual durable tag" }] },
      });
      expect(response.ok).toBe(true);
      await waitUntil(
        async () => {
          const rows = query(
            "SELECT count(*) n FROM work_jobs WHERE subject=? AND state IN ('pending','running')",
            [bookmark.id],
          ) as { n: number }[];
          return rows[0].n === 0;
        },
        "Manual tag publication settles before pausing execution",
        120000,
      );
      pauseEngine(true);
      try {
        const old = claimTag(bookmark.id);
        run("UPDATE bookmarkTexts SET text=? WHERE id=?", [
          "The user changed this document.",
          bookmark.id,
        ]);
        expect(
          rpc("complete", {
            ...old,
            result: { kind: "tags", tags: ["stale-result-tag"] },
          }),
        ).toBe(true);
        expect(
          query("SELECT state FROM work_jobs WHERE id=?", [old.id]),
        ).toEqual([{ state: "obsolete" }]);
        expect(
          query("SELECT name FROM bookmarkTags WHERE name='stale-result-tag'"),
        ).toEqual([]);
        const current = claimTag(bookmark.id);
        const completion = {
          ...current,
          result: { kind: "tags", tags: ["fresh-result-tag"] },
        };
        expect(rpc("complete", completion)).toBe(true);
        expect(rpc("complete", completion)).toBe(true);
        const { data } = await client.GET("/bookmarks/{bookmarkId}", {
          params: { path: { bookmarkId: bookmark.id } },
        });
        assert(data);
        expect(data.tags.map((t) => t.name)).toContain("Manual durable tag");
        expect(
          data.tags.filter((t) => t.name === "fresh-result-tag"),
        ).toHaveLength(1);
      } finally {
        pauseEngine(false);
      }
    },
    180000,
  );
});
