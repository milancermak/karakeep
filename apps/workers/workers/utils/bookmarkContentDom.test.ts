import { JSDOM } from "jsdom";
import { expect, test } from "vitest";

import {
  createBookmarkSourceTextWalker,
  isBookmarkOwnerNote,
} from "@karakeep/shared/utils/bookmark-content-dom";

test("source highlight offsets exclude editable notes and their separator", () => {
  const dom = new JSDOM(
    "<main><section data-karakeep-owner-note><p>Private note</p></section><hr data-karakeep-owner-note><p>First source paragraph.</p><p>Second source paragraph.</p></main>",
  );
  try {
    const container = dom.window.document.querySelector("main")!;
    const sourceOffsets = () => {
      const walker = createBookmarkSourceTextWalker(container);
      const ranges: { text: string; start: number; end: number }[] = [];
      let offset = 0;
      while (walker.nextNode()) {
        const text = walker.currentNode.textContent ?? "";
        ranges.push({ text, start: offset, end: offset + text.length });
        offset += text.length;
      }
      return ranges;
    };
    const original = sourceOffsets();
    expect(original).toEqual([
      { text: "First source paragraph.", start: 0, end: 23 },
      { text: "Second source paragraph.", start: 23, end: 47 },
    ]);
    const note = container.querySelector("section p")!;
    expect(isBookmarkOwnerNote(note.firstChild!)).toBe(true);
    note.textContent =
      "A much longer replacement note that changes no source offsets.";
    expect(sourceOffsets()).toEqual(original);
    container.querySelector("section")!.remove();
    expect(sourceOffsets()).toEqual(original);
  } finally {
    dom.window.close();
  }
});
