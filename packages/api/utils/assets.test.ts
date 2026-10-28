import { Readable } from "node:stream";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { metadata } = vi.hoisted(() => ({
  metadata: {
    contentType: "application/octet-stream",
    fileName: 'report"\r\n.txt',
  },
}));
vi.mock("@karakeep/shared-server", () => ({
  readAssetMetadata: async () => metadata,
  getAssetSize: async () => 4,
  createAssetReadStream: async () => Readable.from([Buffer.from("file")]),
}));
vi.mock("./upload", async () => {
  const { Readable } = await import("node:stream");
  return { toWebReadableStream: (stream: Readable) => Readable.toWeb(stream) };
});

import { serveAsset } from "./assets";

describe("generic asset downloads", () => {
  const app = new Hono().get("/asset", (c) => serveAsset(c, "asset", "user"));
  beforeEach(() => {
    metadata.contentType = "application/octet-stream";
  });

  it("forces download and strips control characters from the filename", async () => {
    const response = await app.request("http://localhost/asset");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="report___.txt"',
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toBe("file");
  });

  it("preserves inline image responses", async () => {
    metadata.contentType = "image/png";
    const response = await app.request("http://localhost/asset");
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Disposition")).toBeNull();
    expect(await response.text()).toBe("file");
  });
});
