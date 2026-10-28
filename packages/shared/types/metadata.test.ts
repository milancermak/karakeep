import { describe, expect, it } from "vitest";
import {
  bookmarkMetadataSearchText,
  MAX_METADATA_BYTES,
  mergeBookmarkMetadata,
  zBookmarkMetadataSchema,
} from "./metadata";

describe("bookmark metadata", () => {
  it("merges nested client properties without erasing other clients' data", () => {
    const original = {
      capture: { pageTitle: "Original", method: "firefox" },
      custom: { kept: true },
    };
    expect(
      mergeBookmarkMetadata(original, {
        capture: { pageTitle: "Updated" },
        x: { rootPostId: "123" },
      }),
    ).toEqual({
      capture: { pageTitle: "Updated", method: "firefox" },
      custom: { kept: true },
      x: { rootPostId: "123" },
    });
    expect(original.capture.pageTitle).toBe("Original");
  });
  it("deletes null properties, replaces arrays, and supports clearing the object", () => {
    expect(
      mergeBookmarkMetadata(
        { capture: { pageTitle: "Old", method: "firefox" }, values: [1, 2] },
        {
          capture: { pageTitle: null },
          values: [3],
        },
      ),
    ).toEqual({ capture: { method: "firefox" }, values: [3] });
    expect(
      mergeBookmarkMetadata({ capture: { method: "firefox" } }, null),
    ).toEqual({});
  });
  it("rejects non-JSON values, excessive depth and oversized accumulated metadata", () => {
    expect(
      zBookmarkMetadataSchema.safeParse({ value: undefined }).success,
    ).toBe(false);
    expect(
      zBookmarkMetadataSchema.safeParse({ value: new Date() }).success,
    ).toBe(false);
    expect(zBookmarkMetadataSchema.safeParse({ value: Infinity }).success).toBe(
      false,
    );
    let nested: unknown = "leaf";
    for (let n = 0; n < 20; n++) nested = { nested };
    expect(zBookmarkMetadataSchema.safeParse(nested).success).toBe(false);
    expect(
      zBookmarkMetadataSchema.safeParse({
        text: "🙂".repeat(MAX_METADATA_BYTES / 4),
      }).success,
    ).toBe(false);
    expect(() =>
      mergeBookmarkMetadata(
        { first: "a".repeat(40000) },
        { second: "b".repeat(40000) },
      ),
    ).toThrow();
  });
  it("does not allow object-prototype mutation through nested metadata", () => {
    expect(
      zBookmarkMetadataSchema.safeParse(
        JSON.parse('{"__proto__":{"polluted":true}}'),
      ).success,
    ).toBe(false);
    const patch = JSON.parse('{"capture":{"__proto__":{"polluted":true}}}');
    expect(zBookmarkMetadataSchema.safeParse(patch).success).toBe(false);
    expect(() => mergeBookmarkMetadata({}, patch)).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("indexes descriptive metadata and explicit search text without operational values", () => {
    expect(
      bookmarkMetadataSearchText({
        capture: { pageTitle: "Agent compute", capturedAt: "2026-01-01" },
        search: { text: "hosting runtime", keywords: ["VPS", "Agent compute"] },
        x: { rootPostId: "12345", threadCapture: "complete" },
        custom: { secret: "not indexed" },
      }),
    ).toBe("Agent compute\nhosting runtime\nVPS");
  });
});
