import { describe, expect, it } from "vitest";
import {
  GENERATED_TITLE_MAX_LENGTH,
  hasBookmarkTitle,
  normalizeGeneratedTitle,
  titleContent,
} from "./titles";

describe("generated titles", () => {
  it("treats absent and whitespace-only titles as missing while preserving real titles", () => {
    for (const value of [undefined, null, "", " \t\n", "\u2003"])
      expect(hasBookmarkTitle(value)).toBe(false);
    expect(hasBookmarkTitle("  My own title  ")).toBe(true);
  });
  it("bounds imperfect model output without splitting Unicode characters", () => {
    expect(
      normalizeGeneratedTitle(
        'Title: "Rust engine memory usage"\nExtra explanation',
      ),
    ).toBe("Rust engine memory usage");
    expect(normalizeGeneratedTitle('""')).toBeNull();
    expect(normalizeGeneratedTitle("  \n ")).toBeNull();
    const unicode = normalizeGeneratedTitle("🙂".repeat(100))!;
    expect(Array.from(unicode)).toHaveLength(GENERATED_TITLE_MAX_LENGTH);
    expect(unicode).not.toContain("�");
    const words = normalizeGeneratedTitle(
      "A long generated title about efficient Rust background processing with database storage and many other topics",
    )!;
    expect(words.length).toBeLessThanOrEqual(GENERATED_TITLE_MAX_LENGTH);
    expect(words.endsWith("processin")).toBe(false);
  });
  it("uses annotations, content and descriptive metadata without operational values", () => {
    const content = titleContent({
      note: "Another agent hosting runtime",
      text: "A startup provides isolated containers for AI agents.",
      metadata: {
        capture: { pageTitle: "Agent runtime", status: "complete" },
        x: { postId: "123456789" },
      },
    });
    expect(content).toContain("Another agent hosting runtime");
    expect(content).toContain("isolated containers for AI agents");
    expect(content).toContain("Agent runtime");
    expect(content).not.toContain("123456789");
    expect(content).not.toContain("complete");
  });
});
