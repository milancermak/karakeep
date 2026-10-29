// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Readability } from "@mozilla/readability";

import {
  assembleXCapture,
  captureXPage,
  parseXTarget,
  readXPosts,
  selectXThread,
} from "../src/content-scripts/x-capture";

function post(id: string, author: string, content: string) {
  return `<article data-testid="tweet"><a href="/${author}/status/${id}"><time datetime="2026-10-29T12:00:00Z"></time></a><div data-testid="tweetText">${content}</div></article>`;
}

beforeEach(() => {
  vi.stubGlobal("location", new URL("https://x.com/author/status/200"));
  document.body.innerHTML = "";
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("X URLs", () => {
  test("accepts Twitter aliases and removes sharing/media suffixes", () => {
    expect(
      parseXTarget("https://mobile.twitter.com/Author/status/200/photo/1?s=20"),
    ).toEqual({
      kind: "post",
      author: "Author",
      id: "200",
      url: "https://x.com/Author/status/200",
    });
    expect(parseXTarget("https://x.com/i/article/123")).toEqual({
      kind: "article",
      id: "123",
      url: "https://x.com/i/article/123",
    });
    expect(
      parseXTarget("https://x.com.evil.test/author/status/200"),
    ).toBeNull();
    expect(parseXTarget("https://x.com/author")).toBeNull();
  });
});

describe("X post DOM", () => {
  test("keeps X-host content links while excluding surrounding post UI and quotes", () => {
    document.body.innerHTML = `<main data-testid="primaryColumn"><article data-testid="tweet"><a href="/author/status/200"><time></time></a><a href="/author/status/200/analytics">Views</a><div data-testid="tweetText">Read <a href="https://x.com/other/status/123">this post</a> and <a href="https://x.com/search?q=%23agents">#agents</a></div><div role="link"><a href="/quoted/status/99">Quoted post</a><div data-testid="tweetText"><a href="https://x.com/quoted-link/status/100">Quoted link</a></div></div></article></main>`;
    expect(readXPosts()[0].links).toEqual([
      { url: "https://x.com/other/status/123", sourcePostId: "200" },
      { url: "https://x.com/search?q=%23agents", sourcePostId: "200" },
    ]);
  });

  test("preserves inline linked words through the actual Readability consumer", () => {
    const paragraphs = [
      'We have been using <div class="source-inline"><a href="https://example.com/scouts">Scouts</a></div> to automate repetitive engineering tasks. The captured article must retain the linked word in the middle of this sentence, together with the surrounding explanatory text and its paragraph boundary.',
      'The team validated <div style="display:inline"><a href="https://example.com/patch">this small production fix</a></div> by checking deployment logs and traffic. This paragraph deliberately provides enough prose for the real reader extractor to identify it as useful article content rather than a list of navigation links.',
      'The last section explains how to use <div style="display:inline-flex"><a href="https://x.com/other/status/123">a published example</a></div> as the basis for future work. The link belongs to the original article and should remain alongside the complete paragraph rather than being removed as an isolated link block.',
    ];
    document.head.innerHTML =
      "<style>.source-inline { display: inline; }</style>";
    document.body.innerHTML = `<main data-testid="primaryColumn"><article data-testid="tweet"><a href="/author/status/200"><time></time></a><article data-testid="twitterArticleReadView"><div data-testid="twitter-article-title">Engineering article</div><div data-testid="twitterArticleRichTextView">${paragraphs.map((paragraph) => `<div data-block="true">${paragraph}</div>`).join("")}</div></article></article></main>`;
    const capture = assembleXCapture(
      parseXTarget(location.href)!,
      readXPosts(),
      { status: "complete", kind: "article", title: "Engineering article" },
    );
    const parsedDocument = new DOMParser().parseFromString(
      capture.html,
      "text/html",
    );
    const reader = new Readability(parsedDocument).parse();
    expect(reader).not.toBeNull();
    const text = reader!.textContent!.replace(/\s+/g, " ");
    for (const paragraph of paragraphs) {
      const expected = new DOMParser()
        .parseFromString(paragraph, "text/html")
        .body.textContent!.replace(/\s+/g, " ");
      expect(text).toContain(expected);
    }
    expect(text).toContain("using Scouts to automate");
    expect(text).toContain("validated this small production fix by checking");
    expect(text).toContain("use a published example as the basis");
    const content = new DOMParser().parseFromString(
      reader!.content!,
      "text/html",
    );
    expect(
      Array.from(content.querySelectorAll("p")).filter((paragraph) =>
        /^(We have|The team|The last section)/.test(
          paragraph.textContent ?? "",
        ),
      ),
    ).toHaveLength(3);
    expect(
      Array.from(content.querySelectorAll("a"))
        .filter((anchor) => anchor.href !== "https://x.com/author/status/200")
        .map((anchor) => anchor.textContent),
    ).toEqual(["Scouts", "this small production fix", "a published example"]);
    document.head.innerHTML = "";
  });

  test("retains a complete link-dense DraftEditor paragraph through Readability", () => {
    const first =
      'The team validated <div class="source-inline"><a href="https://example.com/fix">this agent-generated production string length limit fix</a></div> with <div class="source-inline"><a href="https://example.com/person">the engineer responsible for the deployment</a></div> before publishing the result.';
    const second =
      "The following section explains the complete operational context for this work, including the original problem, the chosen implementation, and how the team checked the resulting behavior in production. All of this explanatory prose belongs to the captured article.";
    document.body.innerHTML = `<main data-testid="primaryColumn"><article data-testid="tweet"><a href="/author/status/200"><time></time></a><article data-testid="twitterArticleReadView"><div data-testid="twitter-article-title">Production validation</div><div data-testid="twitterArticleRichTextView"><div data-block="true"><div class="public-DraftStyleDefault-block">${first}</div></div><div data-block="true"><div class="public-DraftStyleDefault-block">${second}</div></div></div></article></article></main>`;
    const capture = assembleXCapture(
      parseXTarget(location.href)!,
      readXPosts(),
      { status: "complete", kind: "article", title: "Production validation" },
    );
    const dom = new DOMParser().parseFromString(capture.html, "text/html");
    expect(
      dom
        .querySelector('meta[name="karakeep:content"]')
        ?.getAttribute("content"),
    ).toBe("x-capture-v1");
    expect(
      dom.querySelector('article[data-karakeep-capture="x-capture-v1"]'),
    ).not.toBeNull();
    const reader = new Readability(dom).parse();
    const text = reader!.textContent!.replace(/\s+/g, " ");
    expect(text).toContain(
      new DOMParser().parseFromString(first, "text/html").body.textContent,
    );
    expect(text).toContain(second);
  });

  test("uses primary conversation only, excludes quotes and preserves media and expanded links", () => {
    document.body.innerHTML = `<aside>${post("1", "side", "sidebar")}</aside><main data-testid="primaryColumn">${post("200", "author", 'Main <a href="https://t.co/abc" title="https://github.com/example/project">repo</a><img alt="😀" src="https://abs.twimg.com/emoji.svg"><span onclick="bad()"> safe</span><script>bad()</script>')}
      <article data-testid="tweet"><a href="/author/status/201"><time></time></a><div data-testid="tweetText">Continuation</div><div role="link"><a href="/quoted/status/9"><time></time></a><div data-testid="tweetText">Quoted text <a href="https://evil.test">quoted link</a></div><div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/quote?format=png&name=small"></div></div><div data-testid="tweetPhoto"><img alt="diagram" src="https://pbs.twimg.com/media/diagram?format=png&name=small"></div></article></main>`;
    const posts = readXPosts();
    expect(posts.map((entry) => entry.id)).toEqual(["200", "201"]);
    expect(posts[0].html).toContain(
      'href="https://github.com/example/project"',
    );
    expect(posts[0].html).not.toMatch(/onclick|script|bad\(\)/);
    expect(posts[0].text).toContain("😀 safe");
    expect(posts[1].text).toBe("Continuation");
    expect(posts[1].links).toEqual([]);
    expect(posts[1].images).toEqual([
      {
        url: "https://pbs.twimg.com/media/diagram?format=png&name=orig",
        alt: "diagram",
        sourcePostId: "201",
      },
    ]);
  });

  test("does not use a quoted post as the identity or body of an empty quote-post", () => {
    document.body.innerHTML =
      '<main data-testid="primaryColumn"><article data-testid="tweet"><div role="link"><a role="link" href="/quoted/status/9"><time></time></a><div data-testid="tweetText">Quoted only</div></div><a role="link" href="/author/status/200"><time></time></a></article></main>';
    expect(readXPosts()[0]).toMatchObject({
      id: "200",
      author: "author",
      text: "",
      html: "",
    });
  });
});

describe("X archive assembly", () => {
  test("orders snowflakes without number precision loss and deduplicates links", () => {
    document.body.innerHTML = `<main data-testid="primaryColumn">${post("2115466098174996717", "author", '<a href="https://github.com/example/project">Later</a>')}${post("2115466098174996715", "author", '<a href="https://github.com/example/project">Earlier</a>')}</main>`;
    const posts = readXPosts();
    const result = assembleXCapture(
      parseXTarget(location.href)!,
      [...posts, posts[0]],
      { status: "complete" },
    );
    expect(result.metadata.x.posts.map((entry) => entry.id)).toEqual([
      "2115466098174996715",
      "2115466098174996717",
    ]);
    expect(result.metadata.x.links).toHaveLength(1);
    expect(result.text).toBe("Earlier\n\n---\n\nLater");
  });

  test("limits metadata while keeping full links in the content", () => {
    document.body.innerHTML = `<main data-testid="primaryColumn">${post("200", "author", Array.from({ length: 150 }, (_, index) => `<a href="https://example.com/${index}/${"a".repeat(600)}">link ${index}</a>`).join(" "))}</main>`;
    const result = assembleXCapture(
      parseXTarget(location.href)!,
      readXPosts(),
      { status: "partial", reason: "Continuation did not load" },
    );
    expect(
      new TextEncoder().encode(JSON.stringify(result.metadata)).byteLength,
    ).toBeLessThanOrEqual(60_000);
    expect(result.metadata.capture.metadataTruncated).toBe(true);
    expect(result.metadata.capture.status).toBe("partial");
    expect(result.html).toContain("link 149");
  });
});

describe("thread boundaries", () => {
  test("keeps the author's connected run and excludes their later replies to readers", () => {
    document.body.innerHTML = `<main data-testid="primaryColumn">${post("199", "Author", "Beginning")}${post("200", "author", "Selected post")}${post("201", "author", "Continuation")}${post("202", "reader", "A question")}${post("203", "author", "A reply to the reader")}</main>`;
    const result = selectXThread(readXPosts(), parseXTarget(location.href)!);
    expect(result.posts.map((entry) => entry.id)).toEqual([
      "199",
      "200",
      "201",
    ]);
    expect(result.boundaryFound).toBe(true);
  });

  test("does not count a loading or missing continuation as a known boundary", () => {
    document.body.innerHTML = `<main data-testid="primaryColumn">${post("200", "author", "Selected post")}<div role="progressbar"></div></main>`;
    expect(
      selectXThread(readXPosts(), parseXTarget(location.href)!).boundaryFound,
    ).toBe(false);
  });
});

describe("foreground capture", () => {
  test("collects a virtualized author thread and excludes later author conversations", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<main data-testid="primaryColumn">${post("200", "author", "Beginning")}${post("201", "author", "Part two")}</main>`;
    let scrolls = 0;
    vi.mocked(window.scrollTo).mockImplementation(() => {
      if (++scrolls === 2)
        document.body.innerHTML = `<main data-testid="primaryColumn">${post("201", "author", "Part two")}${post("202", "author", "Part three")}${post("203", "reader", "Question")}${post("204", "author", "A reply")}</main>`;
    });
    const pending = captureXPage();
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;
    expect(result.metadata.capture.status).toBe("complete");
    expect(result.metadata.x.posts.map((entry) => entry.id)).toEqual([
      "200",
      "201",
      "202",
    ]);
    expect(result.text).not.toContain("A reply");
  });

  test("captures a full article body and inline images without engagement or upsell text", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<main data-testid="primaryColumn"><article data-testid="tweet"><a href="/author/status/200"><time></time></a><article data-testid="twitterArticleReadView"><div data-testid="twitter-article-title">Article title</div><div>1,000 likes</div><div data-testid="twitterArticleRichTextView"><div><h1>Section one</h1><p>Body <a href="https://github.com/example/project">repository</a></p><div data-testid="tweetPhoto"><img alt="Diagram" src="https://pbs.twimg.com/media/diagram?format=png&name=medium"></div><pre>Untrusted source instructions remain plain content.</pre><ul><li>Final point</li></ul></div></div><div>Upgrade to Plus</div></article></article></main>`;
    const pending = captureXPage();
    await vi.advanceTimersByTimeAsync(1_500);
    const result = await pending;
    expect(result.metadata.x.kind).toBe("article");
    expect(result.title).toBe("Article title");
    expect(result.html).toContain("Section one");
    expect(result.html).toContain("Final point");
    expect(result.html).toContain(
      'src="https://pbs.twimg.com/media/diagram?format=png&amp;name=orig"',
    );
    expect(result.html).not.toContain("1,000 likes");
    expect(result.html).not.toContain("Upgrade to Plus");
    expect(result.metadata.x.images).toHaveLength(1);
    expect(result.metadata.x.links[0].url).toBe(
      "https://github.com/example/project",
    );
  });

  test("returns partial when it cannot establish a thread boundary", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<main data-testid="primaryColumn">${post("200", "author", "Beginning")}</main>`;
    const pending = captureXPage({ timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_100);
    expect((await pending).metadata.capture.status).toBe("partial");
  });

  test("captures a direct article focus view without a tweet wrapper", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("location", new URL("https://x.com/author/article/200"));
    document.body.innerHTML =
      '<article data-testid="twitterArticleReadView"><div data-testid="twitter-article-title">Focus article</div><div data-testid="twitterArticleRichTextView"><p>Full focus-mode content</p></div></article>';
    const pending = captureXPage();
    await vi.advanceTimersByTimeAsync(1_500);
    const result = await pending;
    expect(result.metadata.capture.status).toBe("complete");
    expect(result.metadata.x.kind).toBe("article");
    expect(result.metadata.source.author).toBe("author");
    expect(result.text).toBe("Full focus-mode content");
  });

  test("reports login blocking and cancellation", async () => {
    document.body.innerHTML = '<a href="/i/flow/login">Log in</a>';
    await expect(captureXPage()).rejects.toThrow("Sign into X");
    const controller = new AbortController();
    controller.abort(new Error("Cancelled by user"));
    await expect(captureXPage({ signal: controller.signal })).rejects.toThrow(
      "Cancelled by user",
    );
  });
});
