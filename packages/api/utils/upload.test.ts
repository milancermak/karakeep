import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { saved, quota } = vi.hoisted(() => ({
  saved: vi.fn(),
  quota: vi.fn(async () => ({ userId: "capture-user", approvedSize: 1024 })),
}));

vi.mock("@karakeep/shared/config", () => ({
  default: { maxAssetSizeMb: 1 },
}));
vi.mock("@karakeep/shared-server", async () => ({
  newAssetId: () => "capture-asset",
  QuotaService: { checkStorageQuota: quota },
  StorageQuotaError: class extends Error {},
  SUPPORTED_UPLOAD_ASSET_TYPES: (await import("@karakeep/shared/assetdb"))
    .SUPPORTED_UPLOAD_ASSET_TYPES,
  saveAssetFromFile: saved,
}));

import { uploadAsset } from "./upload";

describe("capture file uploads", () => {
  const db = {
    insert: () => ({
      values: () => ({
        returning: async () => [{ id: "capture-asset" }],
      }),
    }),
  };
  let storedBytes: Buffer;

  beforeEach(() => {
    saved.mockReset();
    quota.mockClear();
    saved.mockImplementation(async ({ assetPath }) => {
      storedBytes = await readFile(assetPath);
    });
  });

  it("keeps arbitrary file bytes with a download-only content type", async () => {
    const file = new File(["A plain text attachment\n"], "note.txt", {
      type: "application/octet-stream",
    });
    const result = await uploadAsset(
      { id: "capture-user" } as never,
      db as never,
      { file },
    );
    expect(result).toMatchObject({
      assetId: "capture-asset",
      contentType: "application/octet-stream",
      fileName: "note.txt",
    });
    expect(storedBytes.toString()).toBe("A plain text attachment\n");
    expect(quota).toHaveBeenCalledOnce();
  });

  it("stores sniffed unsupported formats as binary only for explicit opt-in", async () => {
    const zip = Buffer.from(
      "504b03041400000000000000000000000000000000000000000000000000",
      "hex",
    );
    const result = await uploadAsset(
      { id: "capture-user" } as never,
      db as never,
      {
        file: new File([zip], "archive.zip", {
          type: "application/octet-stream",
        }),
      },
    );
    expect(result).toMatchObject({ contentType: "application/octet-stream" });
    expect(storedBytes).toEqual(zip);
  });

  it("preserves image detection when uploaded as binary", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/1sAAAAASUVORK5CYII=",
      "base64",
    );
    const result = await uploadAsset(
      { id: "capture-user" } as never,
      db as never,
      {
        file: new File([png], "image.png", {
          type: "application/octet-stream",
        }),
      },
    );
    expect(result).toMatchObject({ contentType: "image/png" });
    expect(storedBytes).toEqual(png);
  });

  it("continues rejecting spoofed images and unsupported non-generic MIME types", async () => {
    for (const type of ["image/png", "text/plain"]) {
      const result = await uploadAsset(
        { id: "capture-user" } as never,
        db as never,
        { file: new File(["not an image"], "fake.png", { type }) },
      );
      expect(result).toEqual({ error: "Unsupported asset type", status: 400 });
    }
    expect(saved).not.toHaveBeenCalled();
  });

  it("enforces the upload limit for generic files", async () => {
    const result = await uploadAsset(
      { id: "capture-user" } as never,
      db as never,
      {
        file: new File([new Uint8Array(1024 * 1024 + 1)], "large.bin", {
          type: "application/octet-stream",
        }),
      },
    );
    expect(result).toEqual({ error: "Asset is too big", status: 413 });
    expect(quota).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
  });
});
