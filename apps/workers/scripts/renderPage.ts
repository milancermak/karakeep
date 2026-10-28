// Stateless rendering helper. It does not open the database, own a queue, or
// mutate application state. The Rust engine owns its timeout and process group.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import winston from "winston";
import { z } from "zod";
import config from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";
import { matchesNoProxy, selectRunProxies, validateUrl } from "../network";
import {
  initializeBrowserEnvironment,
  startBrowserInstance,
  getBrowserUserAgent,
  getGlobalBlocker,
  getGlobalCookies,
  getPlaywrightProxyConfig,
} from "../workers/utils/browser";
import { installRedirectGuard } from "../workers/utils/redirectGuard";
import {
  installAutoconsent,
  waitForPageLoadAndAutoconsent,
} from "../workers/utils/autoconsent";
import {
  isWaitableChallenge,
  isLikelyChallengePage,
} from "../workers/utils/metadataResolver";

logger.clear();
logger.add(new winston.transports.Stream({ stream: process.stderr }));
const requestSchema = z.object({
  url: z.string(),
  jobId: z.string(),
  workDir: z.string(),
  htmlPath: z.string().optional(),
  storeScreenshot: z.boolean().optional(),
  fullPageScreenshot: z.boolean().optional(),
  storePdf: z.boolean().optional(),
});

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const input = requestSchema.parse(JSON.parse(raw));
  await initializeBrowserEnvironment();
  const browser = await startBrowserInstance();
  if (!browser) throw new Error("No renderer configured");
  const proxy = getPlaywrightProxyConfig(selectRunProxies());
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: "block",
    userAgent: await getBrowserUserAgent(browser),
    proxy,
    timezoneId: config.crawler.browserTimezone,
    ...(input.htmlPath ? { javaScriptEnabled: false, offline: true } : {}),
  });
  const abort = AbortSignal.timeout(
    (config.crawler.navigateTimeoutSec + config.crawler.challengeWaitSec + 20) *
      1000,
  );
  try {
    const cookies = getGlobalCookies();
    if (cookies.length) await context.addCookies(cookies);
    const page = await context.newPage();
    const cdp = await installRedirectGuard(context, page, input.jobId, proxy);
    const blocker = getGlobalBlocker();
    if (blocker) await blocker.enableBlockingInPage(page);
    page.on("dialog", (d) => {
      void d.dismiss().catch(() => undefined);
    });
    await page.route("**/*", async (route) => {
      const request = route.request(),
        url = request.url();
      if (input.htmlPath && !url.startsWith("data:") && url !== "about:blank") {
        await route.abort();
        return;
      }
      if (request.resourceType() === "media") {
        await route.abort();
        return;
      }
      if (url.startsWith("http:") || url.startsWith("https:")) {
        const valid = await validateUrl(
          url,
          !!proxy && !matchesNoProxy(url, proxy.bypass?.split(",") ?? []),
        );
        if (!valid.ok) {
          await route.abort();
          return;
        }
      }
      await route.fallback();
    });
    let statusCode = 200;
    const consent = await installAutoconsent(page, input.jobId);
    if (input.htmlPath)
      await page.setContent(await readFile(input.htmlPath, "utf8"), {
        timeout: config.crawler.navigateTimeoutSec * 1000,
        waitUntil: "load",
      });
    else {
      const valid = await validateUrl(
        input.url,
        !!proxy && !matchesNoProxy(input.url, proxy.bypass?.split(",") ?? []),
      );
      if (!valid.ok) throw new Error("Renderer destination blocked");
      const response = await page.goto(input.url, {
        timeout: config.crawler.navigateTimeoutSec * 1000,
        waitUntil: "domcontentloaded",
      });
      statusCode = response?.status() ?? 200;
      await waitForPageLoadAndAutoconsent(
        page,
        page
          .waitForLoadState("networkidle", { timeout: 5000 })
          .catch(() => undefined),
        consent,
        abort,
      );
      const end = Date.now() + config.crawler.challengeWaitSec * 1000;
      while (
        Date.now() < end &&
        isWaitableChallenge(await page.title(), await page.content())
      )
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const html = await page.content(),
      url = input.htmlPath ? input.url : page.url();
    await writeFile(path.join(input.workDir, "render.html"), html, {
      mode: 0o600,
    });
    const artifacts: { path: string; role: string; contentType: string }[] = [];
    if (input.storeScreenshot) {
      try {
        await page.screenshot({
          path: path.join(input.workDir, "screenshot.png"),
          fullPage: input.fullPageScreenshot ?? false,
          timeout: config.crawler.screenshotTimeoutSec * 1000,
        });
        artifacts.push({
          path: "screenshot.png",
          role: "linkScreenshot",
          contentType: "image/png",
        });
      } catch (e) {
        logger.warn(
          `[render] Screenshot failed: ${e instanceof Error ? e.name : "error"}`,
        );
      }
    }
    if (input.storePdf) {
      await page.pdf({
        path: path.join(input.workDir, "page.pdf"),
        printBackground: true,
      });
      artifacts.push({
        path: "page.pdf",
        role: "linkPdf",
        contentType: "application/pdf",
      });
    }
    await cdp?.detach().catch(() => undefined);
    return {
      htmlPath: "render.html",
      url,
      statusCode,
      artifacts,
      blocked:
        isLikelyChallengePage({
          title: await page.title(),
          htmlContent: html,
        }) || statusCode >= 400,
    };
  } finally {
    await context.close().catch(() => undefined);
    // CDP disconnect keeps the broker-owned Chrome alive for its idle window.
    await browser.close().catch(() => undefined);
  }
}
main()
  .then((result) => {
    process.stdout.write(JSON.stringify(result), () => process.exit(0));
  })
  .catch(() => {
    process.stdout.write(JSON.stringify({ error: "Rendering failed" }), () =>
      process.exit(1),
    );
  });
