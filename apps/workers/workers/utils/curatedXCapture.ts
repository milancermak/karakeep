import DOMPurify from "dompurify";
import { JSDOM, VirtualConsole } from "jsdom";

import { assessReaderView } from "./readerViewAssessment";

export function extractCuratedXCapture(htmlContent: string, url: string) {
  if (
    !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(
      new URL(url).hostname,
    ) ||
    !htmlContent.includes("karakeep:content")
  ) {
    return null;
  }
  const virtualConsole = new VirtualConsole();
  const source = new JSDOM(htmlContent, { url, virtualConsole });
  try {
    const marker = source.window.document.head.querySelector(
      'meta[name="karakeep:content"][content="x-capture-v1"]',
    );
    const article = source.window.document.body.querySelector(
      ':scope > article[data-karakeep-capture="x-capture-v1"]',
    );
    if (!marker || !article) return null;

    // The browser already isolated this body; Readability can drop its linked text.
    const content = DOMPurify(source.window).sanitize(article.outerHTML, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: [
        "style",
        "form",
        "button",
        "input",
        "select",
        "textarea",
        "iframe",
        "object",
        "embed",
      ],
      FORBID_ATTR: ["style"],
    });
    const extracted = new JSDOM(content, { url, virtualConsole });
    try {
      return {
        readableContent: { content },
        readerViewAssessment: assessReaderView(
          source.window.document,
          extracted.window.document,
          url,
        ),
      };
    } finally {
      extracted.window.close();
    }
  } finally {
    source.window.close();
  }
}
