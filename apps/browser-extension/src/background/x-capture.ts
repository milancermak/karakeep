import type { ZNewBookmarkRequest } from "@karakeep/shared/types/bookmarks";

import { parseXTarget } from "../content-scripts/x-capture";
import { getPluginSettings } from "../utils/settings";
import { uploadSingleFileAsset } from "../utils/singlefile";
import { getApiClient } from "../utils/trpc";

import type { XCaptureResult } from "../content-scripts/x-capture";

export async function saveXBookmark(
  bookmark: ZNewBookmarkRequest,
  sourceTabId?: number,
  titleIsCustom = false,
) {
  if (bookmark.type !== "link") throw new Error("Expected an X link");
  const target = parseXTarget(bookmark.url);
  if (!target) throw new Error("Expected an X post or article");
  const api = await getApiClient();
  if (!api) throw new Error("Configure your Karakeep server first");

  let tabId = sourceTabId;
  const source = tabId === undefined ? undefined : await chrome.tabs.get(tabId);
  if (!source?.url || parseXTarget(source.url)?.id !== target.id) {
    const tab = await chrome.tabs.create({ url: target.url, active: true });
    tabId = tab.id;
    if (tabId === undefined) throw new Error("Couldn't open the X page");
    for (let attempt = 0; attempt < 120; attempt++) {
      const current = await chrome.tabs.get(tabId);
      if (
        current.status === "complete" &&
        parseXTarget(current.url ?? "")?.id === target.id
      )
        break;
      if (attempt === 119) throw new Error("The X page didn't finish loading");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (tabId === undefined) throw new Error("Couldn't find the X tab");

  const files = chrome.runtime
    .getManifest()
    .content_scripts?.find((script) =>
      script.js?.some((file) => file.includes("x-capture-entry")),
    )?.js;
  if (!files?.length) throw new Error("X capture script is missing");
  await chrome.scripting.executeScript({ target: { tabId }, files });
  try {
    const response = (await chrome.tabs.sendMessage(tabId, {
      type: "KARAKEEP_CAPTURE_X",
    })) as
      | { success: true; capture: XCaptureResult }
      | { success: false; error: string };
    if (!response.success) throw new Error(response.error);
    const capture = response.capture;
    if (capture.metadata.capture.status !== "complete") {
      throw new Error(
        capture.metadata.capture.reason ||
          "Couldn't capture the whole thread. Try again.",
      );
    }
    const settings = await getPluginSettings();
    let html = capture.html;
    const redirectDeadline = Date.now() + 15_000;
    for (const link of capture.metadata.x.links) {
      if (
        new URL(link.url).hostname !== "t.co" ||
        Date.now() >= redirectDeadline
      )
        continue;
      await chrome.tabs.sendMessage(tabId, {
        type: "KARAKEEP_X_STATUS",
        label: "Resolving links…",
      });
      let redirectTabId: number | undefined;
      try {
        const tab = await chrome.tabs.create({ url: link.url, active: false });
        redirectTabId = tab.id;
        if (redirectTabId === undefined) continue;
        await chrome.tabs.update(redirectTabId, { muted: true });
        const deadline = Math.min(Date.now() + 5_000, redirectDeadline);
        while (Date.now() < deadline) {
          const current = await chrome.tabs.get(redirectTabId);
          if (current.url && /^https?:/.test(current.url)) {
            const url = new URL(current.url);
            if (
              url.hostname !== "t.co" &&
              !url.pathname.startsWith("/i/safety/")
            ) {
              link.shortUrl = link.url;
              link.url = url.href;
              if (
                new TextEncoder().encode(JSON.stringify(capture.metadata))
                  .byteLength > 60_000
              ) {
                link.url = link.shortUrl;
                delete link.shortUrl;
                break;
              }
              const original = link.shortUrl
                .replace(/&/g, "&amp;")
                .replace(/"/g, "&quot;");
              const expanded = link.url
                .replace(/&/g, "&amp;")
                .replace(/"/g, "&quot;");
              html = html
                .split(`href="${original}"`)
                .join(`href="${expanded}"`);
              break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      } catch {
        // Preserve the original short URL if its destination cannot be reached.
      } finally {
        if (redirectTabId !== undefined)
          await chrome.tabs.remove(redirectTabId).catch(() => undefined);
      }
    }
    capture.metadata.x.links = capture.metadata.x.links.filter(
      (link, index, links) =>
        links.findIndex((other) => other.url === link.url) === index,
    );
    let imagesEmbedded = 0;
    let imagesFailed = 0;
    let imageBytes = 0;
    if (settings.singleFileIncludeImages && capture.metadata.x.images.length) {
      await chrome.tabs.sendMessage(tabId, {
        type: "KARAKEEP_X_STATUS",
        label: "Saving images…",
      });
      for (const image of capture.metadata.x.images) {
        try {
          const url = new URL(image.url);
          if (url.protocol !== "https:" || url.hostname !== "pbs.twimg.com")
            throw new Error("Unsupported image origin");
          const response = await fetch(url, {
            credentials: "omit",
            signal: AbortSignal.timeout(15_000),
          });
          if (
            !response.ok ||
            !/^image\/(?:jpeg|png|webp|gif|avif)(?:;|$)/i.test(
              response.headers.get("content-type") ?? "",
            )
          )
            throw new Error("Image unavailable");
          const blob = await response.blob();
          if (
            blob.size > 10 * 1024 * 1024 ||
            imageBytes + blob.size > 25 * 1024 * 1024
          )
            throw new Error("Image archive limit reached");
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = "";
          for (let offset = 0; offset < bytes.length; offset += 32_768)
            binary += String.fromCharCode(
              ...bytes.subarray(offset, offset + 32_768),
            );
          const src = image.url
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
          if (!html.includes(`src="${src}"`))
            throw new Error("Image source wasn't present in captured content");
          html = html
            .split(`src="${src}"`)
            .join(`src="data:${blob.type};base64,${btoa(binary)}"`);
          imageBytes += blob.size;
          imagesEmbedded++;
        } catch {
          imagesFailed++;
        }
      }
    }
    await chrome.tabs.sendMessage(tabId, {
      type: "KARAKEEP_X_STATUS",
      label: "Saving to Karakeep…",
    });
    const archiveId = await uploadSingleFileAsset(html, capture.title);
    const saved = await api.bookmarks.createBookmark.mutate({
      ...bookmark,
      url: target.url,
      title:
        capture.metadata.x.kind === "article" && !titleIsCustom
          ? capture.title
          : (bookmark.title ?? capture.title),
      source: "extension",
      precrawledArchiveId: archiveId,
      metadata: {
        ...bookmark.metadata,
        ...capture.metadata,
        capture: { ...capture.metadata.capture, imagesEmbedded, imagesFailed },
      },
    });
    if (saved.alreadyExists) {
      const existingArchive = saved.assets
        .filter((asset) => asset.assetType === "precrawledArchive")
        .slice(-1)[0];
      if (existingArchive) {
        await api.assets.replaceAsset.mutate({
          bookmarkId: saved.id,
          oldAssetId: existingArchive.id,
          newAssetId: archiveId,
        });
      } else {
        await api.assets.attachAsset.mutate({
          bookmarkId: saved.id,
          asset: { id: archiveId, assetType: "precrawledArchive" },
        });
      }
      await api.bookmarks.recrawlBookmark.mutate({ bookmarkId: saved.id });
    }
    await chrome.tabs
      .sendMessage(tabId, { type: "KARAKEEP_X_FINISH", success: true })
      .catch(() => undefined);
    return saved;
  } catch (error) {
    await chrome.tabs
      .sendMessage(tabId, {
        type: "KARAKEEP_X_FINISH",
        success: false,
        error:
          error instanceof Error ? error.message : "Couldn't save this X page",
      })
      .catch(() => undefined);
    throw error;
  }
}
