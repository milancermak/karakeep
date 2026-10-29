import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { zNewBookmarkRequestSchema } from "@karakeep/shared/types/bookmarks";
import { zBookmarkMetadataSchema } from "@karakeep/shared/types/metadata";

import { saveXBookmark } from "../src/background/x-capture";

import type { XCaptureResult } from "../src/content-scripts/x-capture";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  upload: vi.fn(),
  client: vi.fn(),
}));

vi.mock("../src/utils/settings", () => ({ getPluginSettings: mocks.settings }));
vi.mock("../src/utils/singlefile", () => ({
  uploadSingleFileAsset: mocks.upload,
}));
vi.mock("../src/utils/trpc", () => ({ getApiClient: mocks.client }));

const url = "https://x.com/author/status/200";
let capture: XCaptureResult;
let events: string[];
let saved: {
  id: string;
  alreadyExists: boolean;
  assets: { id: string; assetType: string }[];
};
let api: ReturnType<typeof makeApi>;
let browser: ReturnType<typeof makeBrowser>;

function makeApi() {
  return {
    bookmarks: {
      createBookmark: {
        mutate: vi.fn(async (payload: unknown) => {
          zNewBookmarkRequestSchema.parse(payload);
          events.push("create");
          return saved;
        }),
      },
      recrawlBookmark: {
        mutate: vi.fn(async () => {
          events.push("recrawl");
        }),
      },
    },
    assets: {
      replaceAsset: {
        mutate: vi.fn(async () => {
          events.push("replace");
        }),
      },
      attachAsset: {
        mutate: vi.fn(async () => {
          events.push("attach");
        }),
      },
    },
  };
}

function makeBrowser() {
  return {
    tabs: {
      get: vi.fn(async (_tabId: number) => ({
        id: 7,
        url,
        status: "complete",
      })),
      create: vi.fn(async (_options: unknown) => ({ id: 9 })),
      update: vi.fn(async (_tabId: number, _options: unknown) => ({ id: 9 })),
      remove: vi.fn(async (_tabId: number) => undefined),
      sendMessage: vi.fn(async (_tabId: number, message: { type: string }) => {
        if (message.type === "KARAKEEP_CAPTURE_X")
          return { success: true, capture };
        return undefined;
      }),
    },
    runtime: {
      getManifest: vi.fn(() => ({
        content_scripts: [{ js: ["assets/x-capture-entry.js"] }],
      })),
    },
    scripting: { executeScript: vi.fn(async () => []) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  events = [];
  capture = {
    url,
    title: "Author's captured thread",
    html: "<!doctype html><article><p>Captured source content</p></article>",
    text: "Captured source content",
    metadata: {
      capture: {
        method: "x-dom",
        pageTitle: "Author's captured thread",
        capturedAt: "2026-10-29T12:00:00.000Z",
        status: "complete",
      },
      source: { author: "author", url },
      x: {
        kind: "thread",
        requestedPostId: "200",
        posts: [{ id: "200", url }],
        links: [],
        images: [],
      },
    },
  };
  saved = { id: "saved-bookmark", alreadyExists: false, assets: [] };
  api = makeApi();
  browser = makeBrowser();
  vi.stubGlobal("chrome", browser);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("Unexpected network request"))),
  );
  mocks.client.mockResolvedValue(api);
  mocks.settings.mockResolvedValue({ singleFileIncludeImages: true });
  mocks.upload.mockImplementation(async () => {
    events.push("upload");
    return "new-archive";
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("X save contract", () => {
  test("uses the actual article heading instead of the browser document title by default", async () => {
    capture.metadata.x.kind = "article";
    capture.title = "Jobs every engineer should automate with agents";
    await saveXBookmark(
      {
        type: "link",
        url,
        title:
          '(1) PostHog on X: "Jobs every engineer should automate with agents" / X',
      },
      7,
    );
    const payload = zNewBookmarkRequestSchema.parse(
      api.bookmarks.createBookmark.mutate.mock.calls[0][0],
    );
    expect(payload.title).toBe(
      "Jobs every engineer should automate with agents",
    );
    expect(mocks.upload).toHaveBeenCalledWith(capture.html, capture.title);
  });

  test("preserves an explicitly edited title for an X Article", async () => {
    capture.metadata.x.kind = "article";
    capture.title = "Jobs every engineer should automate with agents";
    await saveXBookmark(
      {
        type: "link",
        url,
        title: "Useful engineering automations",
        note: "My context",
      },
      7,
      true,
    );
    const payload = zNewBookmarkRequestSchema.parse(
      api.bookmarks.createBookmark.mutate.mock.calls[0][0],
    );
    expect(payload.title).toBe("Useful engineering automations");
    expect(payload.note).toBe("My context");
  });

  test("uploads clean capture and preserves editable notes and metadata in a schema-valid bookmark", async () => {
    await expect(
      saveXBookmark(
        {
          type: "link",
          url: "https://twitter.com/author/status/200?s=20",
          note: "My own context",
          metadata: { research: { topic: "agents" } },
        },
        7,
      ),
    ).resolves.toEqual(saved);
    expect(mocks.upload).toHaveBeenCalledWith(capture.html, capture.title);
    const payload = api.bookmarks.createBookmark.mutate.mock.calls[0][0];
    const parsed = zNewBookmarkRequestSchema.parse(payload);
    expect(parsed).toMatchObject({
      type: "link",
      url,
      note: "My own context",
      title: capture.title,
      precrawledArchiveId: "new-archive",
      source: "extension",
    });
    expect(zBookmarkMetadataSchema.parse(parsed.metadata)).toMatchObject({
      research: { topic: "agents" },
      source: { author: "author", url },
      capture: { status: "complete", imagesEmbedded: 0, imagesFailed: 0 },
    });
    expect(browser.tabs.create).not.toHaveBeenCalled();
    expect(events).toEqual(["upload", "create"]);
    expect(browser.tabs.sendMessage).toHaveBeenLastCalledWith(7, {
      type: "KARAKEEP_X_FINISH",
      success: true,
    });
  });

  test("does not upload or save a partial thread as though it were complete", async () => {
    capture.metadata.capture.status = "partial";
    capture.metadata.capture.reason = "A continuation failed to load";
    await expect(
      saveXBookmark({ type: "link", url, note: "Keep this note" }, 7),
    ).rejects.toThrow("A continuation failed to load");
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(api.bookmarks.createBookmark.mutate).not.toHaveBeenCalled();
    expect(browser.tabs.sendMessage).toHaveBeenLastCalledWith(7, {
      type: "KARAKEEP_X_FINISH",
      success: false,
      error: "A continuation failed to load",
    });
  });

  test("replaces an old capture before requesting extraction of the new archive", async () => {
    saved.alreadyExists = true;
    saved.assets = [
      { id: "old-archive", assetType: "precrawledArchive" },
      { id: "screenshot", assetType: "screenshot" },
    ];
    await saveXBookmark({ type: "link", url, note: "Updated note" }, 7);
    expect(api.assets.replaceAsset.mutate).toHaveBeenCalledWith({
      bookmarkId: saved.id,
      oldAssetId: "old-archive",
      newAssetId: "new-archive",
    });
    expect(api.assets.attachAsset.mutate).not.toHaveBeenCalled();
    expect(api.bookmarks.recrawlBookmark.mutate).toHaveBeenCalledWith({
      bookmarkId: saved.id,
    });
    expect(events).toEqual(["upload", "create", "replace", "recrawl"]);
  });

  test("attaches a first browser archive to an existing plain URL bookmark", async () => {
    saved.alreadyExists = true;
    await saveXBookmark({ type: "link", url }, 7);
    expect(api.assets.attachAsset.mutate).toHaveBeenCalledWith({
      bookmarkId: saved.id,
      asset: { id: "new-archive", assetType: "precrawledArchive" },
    });
    expect(api.assets.replaceAsset.mutate).not.toHaveBeenCalled();
    expect(events).toEqual(["upload", "create", "attach", "recrawl"]);
  });

  test("expands a t.co redirect and retains its original URL as provenance", async () => {
    const shortUrl = "https://t.co/repository";
    const expanded = "https://github.com/example/project?tab=readme&view=all";
    capture.metadata.x.links = [{ url: shortUrl, sourcePostId: "200" }];
    capture.html = `<article><a href="${shortUrl}">Repository</a></article>`;
    browser.tabs.get.mockImplementation(async (tabId: number) => ({
      id: tabId,
      url: tabId === 9 ? expanded : url,
      status: "complete",
    }));
    await saveXBookmark({ type: "link", url }, 7);
    const payload = zNewBookmarkRequestSchema.parse(
      api.bookmarks.createBookmark.mutate.mock.calls[0][0],
    );
    expect(payload.metadata?.x).toMatchObject({
      links: [{ url: expanded, shortUrl, sourcePostId: "200" }],
    });
    expect(mocks.upload.mock.calls[0][0]).toContain(
      'href="https://github.com/example/project?tab=readme&amp;view=all"',
    );
    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: shortUrl,
      active: false,
    });
    expect(browser.tabs.update).toHaveBeenCalledWith(9, { muted: true });
    expect(browser.tabs.remove).toHaveBeenCalledWith(9);
  });

  test("embeds escaped original-image URLs and counts unavailable or unsupported images", async () => {
    const good = "https://pbs.twimg.com/media/good?format=png&name=orig";
    const unavailable =
      "https://pbs.twimg.com/media/unavailable?format=png&name=orig";
    const unsupported = "https://example.com/private-image.png";
    capture.metadata.x.images = [good, unavailable, unsupported].map(
      (image) => ({ url: image, alt: "Diagram", sourcePostId: "200" }),
    );
    capture.html = `<article>${[good, unavailable, unsupported].map((image) => `<img src="${image.replaceAll("&", "&amp;")}" alt="Diagram">`).join("")}</article>`;
    const fetchMock = vi.fn(async (image: URL, _options?: RequestInit) =>
      image.href === good
        ? new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-type": "image/png" },
          })
        : new Response("Unavailable", {
            status: 404,
            headers: { "content-type": "text/html" },
          }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await saveXBookmark({ type: "link", url }, 7);
    const html = mocks.upload.mock.calls[0][0] as string;
    expect(html).toContain('src="data:image/png;base64,AQID"');
    expect(html).not.toContain(good.replaceAll("&", "&amp;"));
    expect(html).toContain(unavailable.replaceAll("&", "&amp;"));
    const payload = zNewBookmarkRequestSchema.parse(
      api.bookmarks.createBookmark.mutate.mock.calls[0][0],
    );
    expect(
      zBookmarkMetadataSchema.parse(payload.metadata).capture,
    ).toMatchObject({ imagesEmbedded: 1, imagesFailed: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "omit" });
  });

  test("keeps remote image references when embedding is disabled", async () => {
    mocks.settings.mockResolvedValue({ singleFileIncludeImages: false });
    capture.metadata.x.images = [
      {
        url: "https://pbs.twimg.com/media/photo?format=png&name=orig",
        alt: "Photo",
        sourcePostId: "200",
      },
    ];
    await saveXBookmark({ type: "link", url }, 7);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.upload).toHaveBeenCalledWith(capture.html, capture.title);
  });

  test("does not report an image embedded when its source is absent from the archive", async () => {
    capture.metadata.x.images = [
      {
        url: "https://pbs.twimg.com/media/missing?format=png&name=orig",
        alt: "Missing source",
        sourcePostId: "200",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-type": "image/png" },
          }),
      ),
    );
    await saveXBookmark({ type: "link", url }, 7);
    expect(mocks.upload).toHaveBeenCalledWith(capture.html, capture.title);
    const payload = zNewBookmarkRequestSchema.parse(
      api.bookmarks.createBookmark.mutate.mock.calls[0][0],
    );
    expect(
      zBookmarkMetadataSchema.parse(payload.metadata).capture,
    ).toMatchObject({ imagesEmbedded: 0, imagesFailed: 1 });
  });

  test("leaves the bookmark untouched and reports an upload failure", async () => {
    mocks.upload.mockRejectedValue(new Error("Server unavailable"));
    await expect(saveXBookmark({ type: "link", url }, 7)).rejects.toThrow(
      "Server unavailable",
    );
    expect(api.bookmarks.createBookmark.mutate).not.toHaveBeenCalled();
    expect(browser.tabs.sendMessage).toHaveBeenLastCalledWith(7, {
      type: "KARAKEEP_X_FINISH",
      success: false,
      error: "Server unavailable",
    });
  });
});
