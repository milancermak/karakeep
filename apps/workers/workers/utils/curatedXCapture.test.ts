import { JSDOM } from "jsdom";
import { expect, test } from "vitest";

import { extractCuratedXCapture } from "./curatedXCapture";

const url = "https://x.com/author/status/200";
const body = `<article data-karakeep-capture="x-capture-v1"><h1>Captured article</h1><section data-x-post-id="200"><div>Keep <div><a href="https://github.com/example/first">this linked example</a></div> with every word around it.</div><p><a href="https://example.com/a">Highly</a> <a href="https://example.com/b">linked</a> <a href="https://example.com/c">paragraph</a>.</p><pre>Long complete prompt\nDo not drop the final line.</pre><p>Words by the original author.</p><img alt="Embedded diagram" src="data:image/png;base64,aGVsbG8="></section></article>`;
const archive = (content = body, version = "x-capture-v1") =>
  `<!doctype html><html><head><meta name="karakeep:content" content="${version}"></head><body>${content}</body></html>`;

test("preserves the complete curated body including dense links, prompts and byline", () => {
  const extracted = extractCuratedXCapture(archive(), url)!;
  expect(extracted).not.toBeNull();
  const source = new JSDOM(body);
  const result = new JSDOM(extracted.readableContent.content);
  try {
    expect(result.window.document.body.textContent).toBe(
      source.window.document.body.textContent,
    );
    expect(result.window.document.querySelectorAll("a")).toHaveLength(4);
    expect(result.window.document.querySelector("img")!.src).toBe(
      "data:image/png;base64,aGVsbG8=",
    );
    expect(
      result.window.document.querySelector("section")!.dataset.xPostId,
    ).toBe("200");
  } finally {
    source.window.close();
    result.window.close();
  }
});

test("still sanitizes marked content instead of trusting browser-provided HTML", () => {
  const extracted = extractCuratedXCapture(
    archive(
      `<article data-karakeep-capture="x-capture-v1"><p onclick="alert(1)" style="position:fixed">Kept source text</p><script>alert(1)</script><style>body{display:none}</style><iframe src="https://example.com"></iframe><a href="javascript:alert(1)">Kept link label</a><img src="https://example.com/image.png" onerror="alert(1)"></article>`,
    ),
    url,
  )!;
  expect(extracted.readableContent.content).toContain("Kept source text");
  expect(extracted.readableContent.content).toContain("Kept link label");
  expect(extracted.readableContent.content).not.toMatch(
    /<script|<style|<iframe|onclick|onerror|javascript:|position:fixed/,
  );
});

test("requires the exact marker, direct article and X source host", () => {
  expect(extractCuratedXCapture(archive(body, "x-capture-v2"), url)).toBeNull();
  expect(extractCuratedXCapture(archive(`<div>${body}</div>`), url)).toBeNull();
  expect(extractCuratedXCapture(body, url)).toBeNull();
  expect(
    extractCuratedXCapture(archive(), "https://example.com/article"),
  ).toBeNull();
});
