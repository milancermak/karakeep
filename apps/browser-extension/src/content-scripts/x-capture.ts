export interface XTarget {
  kind: "post" | "article";
  id: string;
  author?: string;
  url: string;
}

export interface XCapturedPost {
  id: string;
  url: string;
  author: string;
  text: string;
  html: string;
  links: { url: string; sourcePostId: string }[];
  images: { url: string; alt: string; sourcePostId: string }[];
  articleTitle?: string;
}

export interface XCaptureResult {
  url: string;
  title: string;
  html: string;
  text: string;
  metadata: {
    capture: {
      method: "x-dom";
      pageTitle: string;
      capturedAt: string;
      status: "complete" | "partial";
      reason?: string;
      metadataTruncated?: boolean;
    };
    source: { author: string; url: string };
    x: {
      kind: "post" | "thread" | "article";
      requestedPostId: string;
      posts: { id: string; url: string }[];
      links: { url: string; sourcePostId: string; shortUrl?: string }[];
      images: { url: string; alt: string; sourcePostId: string }[];
    };
  };
}

export interface XCaptureOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function parseXTarget(value: string): XTarget | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    !/^(?:(?:www|mobile)\.)?(?:x\.com|twitter\.com)$/i.test(url.hostname)
  ) {
    return null;
  }
  const status = /^\/([\w]+)\/status\/(\d+)(?:\/|$)/.exec(url.pathname);
  if (status) {
    return {
      kind: "post",
      author: status[1],
      id: status[2],
      url: `https://x.com/${status[1]}/status/${status[2]}`,
    };
  }
  const article = /^\/(i|[\w]+)\/article\/(\d+)(?:\/|$)/.exec(url.pathname);
  return article
    ? {
        kind: "article",
        id: article[2],
        ...(article[1] !== "i" ? { author: article[1] } : {}),
        url: `https://x.com/${article[1]}/article/${article[2]}`,
      }
    : null;
}

export function assembleXCapture(
  target: XTarget,
  posts: XCapturedPost[],
  options: {
    kind?: "post" | "thread" | "article";
    title?: string;
    status: "complete" | "partial";
    reason?: string;
  },
): XCaptureResult {
  const uniquePosts = Array.from(
    new Map(posts.map((post) => [post.id, post])).values(),
  ).sort((left, right) =>
    BigInt(left.id) < BigInt(right.id)
      ? -1
      : BigInt(left.id) > BigInt(right.id)
        ? 1
        : 0,
  );
  const title =
    options.title ||
    `@${uniquePosts[0]?.author ?? target.author ?? "X"}: ${uniquePosts[0]?.text.slice(0, 140) ?? "Article"}`;
  const links = Array.from(
    new Map(
      uniquePosts.flatMap((post) => post.links).map((link) => [link.url, link]),
    ).values(),
  );
  const images = Array.from(
    new Map(
      uniquePosts
        .flatMap((post) => post.images)
        .map((image) => [image.url, image]),
    ).values(),
  );
  const metadata: XCaptureResult["metadata"] = {
    capture: {
      method: "x-dom",
      pageTitle: title.slice(0, 500),
      capturedAt: new Date().toISOString(),
      status: options.status,
      ...(options.reason ? { reason: options.reason } : {}),
    },
    source: {
      author: uniquePosts[0]?.author ?? target.author ?? "",
      url: target.url,
    },
    x: {
      kind: options.kind ?? (uniquePosts.length > 1 ? "thread" : "post"),
      requestedPostId: target.id,
      posts: uniquePosts.map(({ id, url }) => ({ id, url })),
      links,
      images,
    },
  };
  const encoder = new TextEncoder();
  while (encoder.encode(JSON.stringify(metadata)).byteLength > 60_000) {
    metadata.capture.metadataTruncated = true;
    const list = metadata.x.images.length
      ? metadata.x.images
      : metadata.x.links.length
        ? metadata.x.links
        : metadata.x.posts;
    if (!list.length) break;
    list.splice(Math.floor(list.length * 0.9));
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="karakeep:content" content="x-capture-v1"><title>${escapeHtml(title)}</title></head><body><article data-karakeep-capture="x-capture-v1"><h1>${escapeHtml(title)}</h1>${uniquePosts.map((post) => `<section data-x-post-id="${post.id}"><p><a href="${escapeHtml(post.url)}">@${escapeHtml(post.author)}</a></p>${post.html}</section>`).join("\n")}</article></body></html>`;
  return {
    url: target.url,
    title,
    html,
    text: uniquePosts.map((post) => post.text).join("\n\n---\n\n"),
    metadata,
  };
}

function getHttpUrl(value: string | null, base: string): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function expandedLink(anchor: HTMLAnchorElement): string | null {
  const href = getHttpUrl(anchor.getAttribute("href"), location.href);
  if (!href) return null;
  if (href.hostname === "t.co") {
    for (const value of [
      anchor.getAttribute("data-expanded-url"),
      anchor.getAttribute("title"),
    ]) {
      const expanded =
        value && /^https?:\/\//.test(value)
          ? getHttpUrl(value, location.href)
          : null;
      if (expanded) return expanded.href;
    }
  }
  return href.href;
}

function isQuoted(element: Element, post: Element): boolean {
  for (
    let parent = element.parentElement;
    parent && parent !== post;
    parent = parent.parentElement
  ) {
    if (
      parent.matches('[data-testid="tweet"]') ||
      (parent.matches('[role="link"]:not(a)') &&
        parent.querySelector('a[href*="/status/"]'))
    )
      return true;
  }
  return false;
}

function cleanContent(
  source: Element,
  preserveImages = false,
): { html: string; text: string } {
  const clone = source.cloneNode(true) as Element;
  const inlineDivs = new Set<Element>();
  const paragraphDivs = new Set<Element>();
  const sourceElements = Array.from(source.querySelectorAll("*"));
  const cloneElements = Array.from(clone.querySelectorAll("*"));
  for (let index = 0; index < sourceElements.length; index++) {
    const element = sourceElements[index];
    if (element.tagName !== "DIV") continue;
    if (element.matches('[data-block="true"]')) {
      paragraphDivs.add(cloneElements[index]);
      continue;
    }
    const display =
      source.ownerDocument.defaultView?.getComputedStyle(element).display ?? "";
    const linkOnly =
      element.childElementCount === 1 &&
      element.firstElementChild?.tagName === "A" &&
      Array.from(element.childNodes).every(
        (node) => node.nodeType === 1 || !node.textContent?.trim(),
      );
    if (
      display.startsWith("inline") ||
      display === "contents" ||
      linkOnly ||
      element.classList.contains("public-DraftStyleDefault-block")
    )
      inlineDivs.add(cloneElements[index]);
  }
  clone
    .querySelectorAll("script,style,button,svg,iframe,form")
    .forEach((element) => element.remove());
  for (const image of clone.querySelectorAll("img")) {
    const url = getHttpUrl(image.getAttribute("src"), location.href);
    if (preserveImages && image.closest('[data-testid="tweetPhoto"]') && url) {
      if (
        url.hostname === "pbs.twimg.com" &&
        url.pathname.startsWith("/media/")
      )
        url.searchParams.set("name", "orig");
      const alt = image.getAttribute("alt") ?? "";
      for (const attribute of Array.from(image.attributes))
        image.removeAttribute(attribute.name);
      image.setAttribute("src", url.href);
      image.setAttribute("alt", alt);
    } else
      image.replaceWith(
        document.createTextNode(image.getAttribute("alt") ?? ""),
      );
  }
  for (const element of Array.from(clone.querySelectorAll("*")).reverse()) {
    if (element instanceof HTMLAnchorElement) {
      const url = expandedLink(element);
      for (const attribute of Array.from(element.attributes))
        element.removeAttribute(attribute.name);
      if (url) element.setAttribute("href", url);
      else element.replaceWith(...Array.from(element.childNodes));
    } else if (element.tagName === "IMG") {
      continue;
    } else if (inlineDivs.has(element)) {
      element.replaceWith(...Array.from(element.childNodes));
    } else if (paragraphDivs.has(element)) {
      const paragraph = document.createElement("p");
      paragraph.append(...Array.from(element.childNodes));
      element.replaceWith(paragraph);
    } else if (
      [
        "BR",
        "HR",
        "P",
        "DIV",
        "UL",
        "OL",
        "LI",
        "BLOCKQUOTE",
        "PRE",
        "CODE",
        "H1",
        "H2",
        "H3",
        "H4",
        "STRONG",
        "EM",
        "B",
        "I",
      ].includes(element.tagName)
    ) {
      for (const attribute of Array.from(element.attributes))
        element.removeAttribute(attribute.name);
    } else element.replaceWith(...Array.from(element.childNodes));
  }
  const textClone = clone.cloneNode(true) as Element;
  for (const image of textClone.querySelectorAll("img"))
    image.replaceWith(document.createTextNode(image.getAttribute("alt") ?? ""));
  for (const lineBreak of textClone.querySelectorAll("br"))
    lineBreak.replaceWith(document.createTextNode("\n"));
  for (const block of textClone.querySelectorAll(
    "p,div,li,blockquote,pre,h1,h2,h3,h4",
  ))
    block.append(document.createTextNode("\n"));
  const text = (textClone.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
  return {
    html: preserveImages
      ? clone.innerHTML
      : clone.innerHTML.replace(/\n/g, "<br>"),
    text,
  };
}

function readXPostTarget(element: Element): XTarget | null {
  if (element.parentElement?.closest('[data-testid="tweet"]')) return null;

  const matches = new Map<string, XTarget>();
  for (const link of element.querySelectorAll(
    'a[href*="/status/"], a[href*="/article/"]',
  )) {
    if (
      isQuoted(link, element) ||
      link.closest(
        '[data-testid="tweetText"], [data-testid="card.wrapper"], [data-testid="twitterArticleRichTextView"]',
      )
    ) {
      continue;
    }
    const url = getHttpUrl(link.getAttribute("href"), location.href);
    const target = url && parseXTarget(url.href);
    if (!url || !target) continue;
    const postLink =
      /^\/\w+\/status\/\d+(?:\/(?:analytics|(?:photo|video)\/\d+))?\/?$/.test(
        url.pathname,
      );
    if (postLink || link.querySelector("time")) {
      matches.set(target.id, target);
    }
  }
  if (matches.size > 1) return null;
  return (
    matches.values().next().value ??
    (element.matches('[data-testid="twitterArticleReadView"]')
      ? parseXTarget(location.href)
      : null)
  );
}

export function readXPosts(root: ParentNode = document): XCapturedPost[] {
  const posts: XCapturedPost[] = [];
  const column = root.querySelector('[data-testid="primaryColumn"]') ?? root;
  const elements = Array.from(column.querySelectorAll('[data-testid="tweet"]'));
  if (!elements.length) {
    const article = column.querySelector(
      '[data-testid="twitterArticleReadView"]',
    );
    if (article) elements.push(article);
  }
  for (const element of elements) {
    const target = readXPostTarget(element);
    if (target && !target.author) {
      const authorLink = column
        .querySelector('[data-testid="User-Name"] a[href]')
        ?.getAttribute("href");
      const author = authorLink
        ? /^\/([\w]+)$/.exec(authorLink)?.[1]
        : undefined;
      target.author = author ?? "unknown";
    }
    if (!target?.author) continue;
    const richText = Array.from(
      element.querySelectorAll('[data-testid="twitterArticleRichTextView"]'),
    ).find((candidate) => !isQuoted(candidate, element));
    const content =
      richText ??
      Array.from(element.querySelectorAll('[data-testid="tweetText"]')).find(
        (candidate) => !isQuoted(candidate, element),
      );
    const cleaned = content
      ? cleanContent(content, Boolean(richText))
      : { html: "", text: "" };
    const links: XCapturedPost["links"] = [];
    for (const anchor of element.querySelectorAll<HTMLAnchorElement>(
      "a[href]",
    )) {
      if (isQuoted(anchor, element)) continue;
      const url = expandedLink(anchor);
      if (!url) continue;
      if (
        !content?.contains(anchor) &&
        !anchor.closest('[data-testid="card.wrapper"]')
      )
        continue;
      links.push({ url, sourcePostId: target.id });
    }
    const images: XCapturedPost["images"] = [];
    for (const image of element.querySelectorAll<HTMLImageElement>(
      '[data-testid="tweetPhoto"] img',
    )) {
      if (isQuoted(image, element)) continue;
      const url = getHttpUrl(
        image.currentSrc || image.getAttribute("src"),
        location.href,
      );
      if (!url) continue;
      if (
        url.hostname === "pbs.twimg.com" &&
        url.pathname.startsWith("/media/")
      )
        url.searchParams.set("name", "orig");
      images.push({ url: url.href, alt: image.alt, sourcePostId: target.id });
    }
    const separateImages = images.filter(
      (image) =>
        !richText ||
        !Array.from(richText.querySelectorAll("img")).some(
          (candidate) =>
            candidate.src.split("?")[0] === image.url.split("?")[0],
        ),
    );
    const mediaHtml = separateImages
      .map(
        (image) =>
          `<figure><img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt)}"></figure>`,
      )
      .join("");
    posts.push({
      id: target.id,
      url: target.url,
      author: target.author,
      text: cleaned.text,
      html: richText ? mediaHtml + cleaned.html : cleaned.html + mediaHtml,
      links,
      images,
      ...(richText
        ? {
            articleTitle:
              Array.from(
                element.querySelectorAll(
                  '[data-testid="twitter-article-title"]',
                ),
              )
                .find((candidate) => !isQuoted(candidate, element))
                ?.textContent?.trim() ?? "Article",
          }
        : {}),
    });
  }
  return posts;
}

export async function captureXPage(
  options: XCaptureOptions = {},
): Promise<XCaptureResult> {
  const target = parseXTarget(location.href);
  if (!target)
    throw new Error("Open an X post or article before capturing it.");

  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  const wait = () =>
    new Promise<void>((resolve, reject) => {
      options.signal?.throwIfAborted();
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("Capture cancelled."));
      };
      const timer = setTimeout(
        () => {
          options.signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        Math.min(350, Math.max(0, deadline - Date.now())),
      );
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });

  let restoreScroll: ScrollToOptions | undefined;
  let loadedReplies: XCapturedPost[] = [];
  try {
    while (true) {
      options.signal?.throwIfAborted();
      const column =
        document.querySelector('[data-testid="primaryColumn"]') ??
        document.querySelector('[data-testid="twitterArticleReadView"]');
      if (column) {
        const posts = readXPosts();
        const requested = posts.findIndex((post) => post.id === target.id);
        const main = posts[requested];
        if (
          !main &&
          target.kind === "post" &&
          posts.length &&
          !restoreScroll &&
          window.scrollY > 0
        ) {
          restoreScroll = {
            left: window.scrollX,
            top: window.scrollY,
            behavior: "instant",
          };
          loadedReplies = posts.filter(
            (post) => BigInt(post.id) > BigInt(target.id),
          );
          window.scrollTo({ top: 0, behavior: "instant" });
          await wait();
          continue;
        }
        if (main?.articleTitle && main.text.trim()) {
          return assembleXCapture(target, [main], {
            kind: "article",
            title: main.articleTitle,
            status: "complete",
          });
        }
        if (main && target.kind === "post" && !main.articleTitle) {
          let start = requested;
          while (
            start > 0 &&
            posts[start - 1].author.toLowerCase() === main.author.toLowerCase()
          )
            start--;
          const loaded = [...loadedReplies, ...posts.slice(start)];
          const includedIds = new Set(loaded.map((post) => post.id));
          let expanded = false;
          for (const element of column.querySelectorAll(
            '[data-testid="tweet"]',
          )) {
            const id = readXPostTarget(element)?.id;
            if (!id || !includedIds.has(id)) continue;
            const expansion = element.querySelector<HTMLElement>(
              '[data-testid="tweet-text-show-more-link"]',
            );
            if (expansion && !expansion.closest('a[href], [role="link"]')) {
              expansion.click();
              expanded = true;
            }
          }
          if (expanded) {
            await wait();
            options.signal?.throwIfAborted();
            const updated = new Map(
              readXPosts().map((post) => [post.id, post]),
            );
            return assembleXCapture(
              target,
              loaded.map((post) => {
                const current = updated.get(post.id);
                return current && current.text.length >= post.text.length
                  ? current
                  : post;
              }),
              { status: "complete" },
            );
          }
          return assembleXCapture(target, loaded, { status: "complete" });
        }
        if (
          column.querySelector(
            '[data-testid="error-detail"], [data-testid="emptyState"]',
          )
        ) {
          throw new Error(
            "X could not load this post. Reload the page and try again.",
          );
        }
      } else if (
        document.querySelector(
          'input[autocomplete="username"],a[href="/login"],a[href="/i/flow/login"]',
        )
      ) {
        throw new Error("Sign into X before capturing this page.");
      }
      if (Date.now() >= deadline)
        throw new Error(
          "Karakeep couldn’t match the post in the address bar to the page. Bring it into view and try again.",
        );
      await wait();
    }
  } finally {
    if (restoreScroll) window.scrollTo(restoreScroll);
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}
