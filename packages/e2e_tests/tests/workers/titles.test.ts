import { readFileSync } from "node:fs";
import { assert, beforeEach, describe, expect, inject, it } from "vitest";
import { createKarakeepClient } from "@karakeep/sdk";
import { createTestUser, uploadTestAsset } from "../../utils/api";
import { waitUntil } from "../../utils/general";

describe("Automatic bookmark titles", () => {
  const port = inject("karakeepPort");
  let client: ReturnType<typeof createKarakeepClient>;
  let key: string;
  beforeEach(async () => {
    // Test users disable automatic tagging and summarization. Titles operate
    // independently of both preferences.
    key = await createTestUser();
    client = createKarakeepClient({
      baseUrl: `http://localhost:${port}/api/v1/`,
      headers: { authorization: `Bearer ${key}` },
    });
  });

  async function titled(id: string) {
    await waitUntil(
      async () => {
        const { data } = await client.GET("/bookmarks/{bookmarkId}", {
          params: { path: { bookmarkId: id } },
        });
        return data?.title === "Agent runtime comparison";
      },
      "Generated title is saved",
      120000,
    );
    const { data } = await client.GET("/bookmarks/{bookmarkId}", {
      params: { path: { bookmarkId: id } },
    });
    assert(data);
    return data;
  }

  it.each([undefined, "", " \t "])(
    "generates a short searchable title for a text note with title %j",
    async (title) => {
      const metadata = { capture: { pageTitle: "Original source title" } };
      const { data } = await client.POST("/bookmarks", {
        body: {
          type: "text",
          title,
          text: "Compare two hosting runtimes for AI agents.",
          note: "Another agent hosting runtime",
          metadata,
        },
      });
      assert(data);
      const bookmark = await titled(data.id);
      expect(bookmark.note).toBe("Another agent hosting runtime");
      expect(bookmark.metadata).toEqual(metadata);
      await waitUntil(async () => {
        const { data: results } = await client.GET("/bookmarks/search", {
          params: { query: { q: "Agent runtime comparison" } },
        });
        return results?.bookmarks.some((item) => item.id === data.id) ?? false;
      }, "Generated title enters search");
    },
    180000,
  );

  it("preserves a supplied title, and generates one when the user clears it", async () => {
    const { data } = await client.POST("/bookmarks", {
      body: {
        type: "text",
        title: "My own title",
        text: "A note about agent hosting.",
      },
    });
    assert(data);
    await waitUntil(async () => {
      const { data: current } = await client.GET("/bookmarks/{bookmarkId}", {
        params: { path: { bookmarkId: data.id } },
      });
      expect(current?.title).toBe("My own title");
      return current?.embeddingStatus === "success";
    }, "Explicitly titled note finishes processing");
    const { response } = await client.PATCH("/bookmarks/{bookmarkId}", {
      params: { path: { bookmarkId: data.id } },
      body: { title: null },
    });
    expect(response.status).toBe(200);
    await titled(data.id);
  }, 180000);

  it("generates a title after crawling while preserving source metadata", async () => {
    const { data } = await client.POST("/bookmarks", {
      body: {
        type: "link",
        url: "http://nginx:80/hello.html",
        note: "My annotation",
        metadata: { capture: { pageTitle: "Browser page title" } },
      },
    });
    assert(data);
    const bookmark = await titled(data.id);
    assert(bookmark.content.type === "link");
    expect(bookmark.content.crawlStatus).toBe("success");
    expect(bookmark.content.title).toBe("My test title");
    expect(bookmark.metadata).toEqual({
      capture: { pageTitle: "Browser page title" },
    });
  }, 180000);

  it("uses the image and OCR pipeline for a titleless screenshot", async () => {
    const bytes = readFileSync(
      new URL("../../setup/html/image.png", import.meta.url),
    );
    const asset = await uploadTestAsset(
      key,
      port,
      new File([bytes], "screenshot.png", { type: "image/png" }),
    );
    const { data } = await client.POST("/bookmarks", {
      body: {
        type: "asset",
        assetType: "image",
        assetId: asset.assetId,
        note: "Compare the hosting options in this screenshot",
      },
    });
    assert(data);
    const bookmark = await titled(data.id);
    expect(bookmark.content.type).toBe("asset");
    expect(bookmark.note).toBe(
      "Compare the hosting options in this screenshot",
    );
  }, 180000);
});
