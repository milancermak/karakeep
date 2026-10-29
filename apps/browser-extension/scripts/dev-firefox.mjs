import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--help")) {
  console.log(`Usage: pnpm dev:firefox

Builds and watches the extension, then launches Firefox with automatic reload.
Uses Karakeep Dev and a dedicated profile in .local/firefox-dev.

KARAKEEP_FIREFOX_BINARY   Firefox executable (defaults to regular Firefox)
KARAKEEP_FIREFOX_PROFILE  Dedicated development profile directory

The first run downloads web-ext@10.8.0 through pnpm dlx.
`);
  process.exit(0);
}

const root = fileURLToPath(new URL("../", import.meta.url));
const localDirectory = resolve(root, ".local");
const outputDirectory = resolve(root, "dist-firefox");
const reloadFile = resolve(localDirectory, "firefox-build-ready");
const profileDirectory = resolve(
  root,
  process.env.KARAKEEP_FIREFOX_PROFILE ?? ".local/firefox-dev",
);
const firefoxBinary =
  process.env.KARAKEEP_FIREFOX_BINARY ??
  (process.platform === "darwin"
    ? "/Applications/Firefox.app/Contents/MacOS/firefox"
    : "firefox");

process.chdir(root);
process.env.VITE_BUILD_FIREFOX = "true";
process.env.KARAKEEP_EXTENSION_DEV = "true";
mkdirSync(localDirectory, { recursive: true });

const { build, normalizePath } = await import("vite");
const watcher = await build({
  root,
  build: {
    outDir: outputDirectory,
    watch: {
      exclude: [
        "**/dist/**",
        "**/dist-firefox/**",
        "**/dist-ssr/**",
        "**/.local/**",
        "**/node_modules/**",
        `${normalizePath(profileDirectory)}/**`,
      ],
    },
  },
});
let browserRunner;
let buildFailed = false;

watcher.on("event", (event) => {
  if (event.code === "START") buildFailed = false;
  if (event.code === "ERROR") buildFailed = true;
  if (event.code !== "END" || buildFailed) return;
  writeFileSync(reloadFile, `${Date.now()}\n`);
  if (browserRunner) return;

  browserRunner = spawn(
    "pnpm",
    [
      "dlx",
      "web-ext@10.8.0",
      "run",
      "--no-config-discovery",
      "--no-input",
      "--source-dir",
      outputDirectory,
      "--watch-file",
      reloadFile,
      "--firefox",
      firefoxBinary,
      "--firefox-profile",
      profileDirectory,
      "--profile-create-if-missing",
      "--keep-profile-changes",
    ],
    { cwd: root, stdio: "inherit" },
  );
  browserRunner.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
    void watcher.close();
  });
  browserRunner.on("exit", (code) => {
    process.exitCode = code ?? 0;
    void watcher.close();
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    browserRunner?.kill(signal);
    void watcher.close();
  });
}
