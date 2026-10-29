import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.argv.includes("--help")) {
  console.log(`Usage: pnpm update:nightly

Builds an unsigned Karakeep Local XPI and stages it for every Nightly profile.
Each run increments the local version. Restart Nightly to activate the update.
Uses installed workspace dependencies; does not upload code or use AMO credentials.
`);
  process.exit(0);
}

if (process.platform !== "darwin") {
  throw new Error(
    "This installer configures Firefox Nightly policies on macOS.",
  );
}

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = resolve(root, "../..");
const require = createRequire(import.meta.url);
const installationDirectory = resolve(
  homedir(),
  "Library/Application Support/Karakeep/browser-extension/nightly",
);
const packagePath = resolve(installationDirectory, "karakeep-local.xpi");
const statePath = resolve(installationDirectory, "current.json");
const outputDirectory = resolve(root, ".local/nightly-build");
const ledgerPath = resolve(repository, "DEPLOYMENTS.md");
const identity = JSON.parse(
  readFileSync(resolve(root, "manifest.nightly.json"), "utf8"),
);
const previous = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : undefined;
const release = (previous?.release ?? 0) + 1;
const version = `1.0.${release}`;
const sourceRevision = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
});
if (sourceRevision.status !== 0)
  throw new Error("Cannot identify the source revision.");
const revision = sourceRevision.stdout.trim();
const sourceStatus = spawnSync("git", ["status", "--porcelain"], {
  cwd: repository,
  encoding: "utf8",
});
if (sourceStatus.status !== 0)
  throw new Error("Cannot identify working-tree changes.");
const dirty = sourceStatus.stdout.trim().length > 0;

process.chdir(root);
process.env.VITE_BUILD_FIREFOX = "true";
process.env.KARAKEEP_EXTENSION_NIGHTLY = "true";
process.env.KARAKEEP_EXTENSION_VERSION = version;
delete process.env.KARAKEEP_EXTENSION_DEV;

const typecheck = spawnSync(
  process.execPath,
  [require.resolve("typescript/bin/tsc")],
  {
    cwd: root,
    stdio: "inherit",
  },
);
if (typecheck.status !== 0)
  throw new Error("Typecheck failed; installed package unchanged.");
const { build } = await import("vite");
await build({ root, build: { outDir: outputDirectory, emptyOutDir: true } });
const manifest = JSON.parse(
  readFileSync(resolve(outputDirectory, "manifest.json"), "utf8"),
);
if (
  manifest.version !== version ||
  manifest.browser_specific_settings?.gecko?.id !==
    identity.browser_specific_settings.gecko.id
) {
  throw new Error(
    "Build did not use the expected Nightly identity and version.",
  );
}

mkdirSync(installationDirectory, { recursive: true });
const candidatePath = resolve(installationDirectory, "candidate.xpi");
rmSync(candidatePath, { force: true });
const zip = spawnSync("/usr/bin/zip", ["-q", "-r", "-X", candidatePath, "."], {
  cwd: outputDirectory,
  stdio: "inherit",
});
if (zip.status !== 0)
  throw new Error("Packaging failed; installed package unchanged.");
const sha256 = createHash("sha256")
  .update(readFileSync(candidatePath))
  .digest("hex");
if (existsSync(packagePath)) {
  copyFileSync(packagePath, resolve(installationDirectory, "previous.xpi"));
}

let deploymentError;
try {
  renameSync(candidatePath, packagePath);
  const addonKey = `ExtensionSettings__${identity.browser_specific_settings.gecko.id}`;
  const settings = [
    ["EnterprisePoliciesEnabled", "-bool", "TRUE"],
    ["Preferences__xpinstall.signatures.required__Value", "-bool", "FALSE"],
    ["Preferences__xpinstall.signatures.required__Status", "-string", "locked"],
    [`${addonKey}__installation_mode`, "-string", "normal_installed"],
    [`${addonKey}__install_url`, "-string", pathToFileURL(packagePath).href],
    [`${addonKey}__updates_disabled`, "-bool", "TRUE"],
  ];
  for (const setting of settings) {
    const result = spawnSync(
      "/usr/bin/defaults",
      ["write", "org.mozilla.nightly", ...setting],
      {
        stdio: "inherit",
      },
    );
    if (result.status !== 0)
      throw new Error(`Could not configure Nightly policy ${setting[0]}.`);
  }
} catch (error) {
  deploymentError = error;
}

const completedAt = new Date().toISOString();
const outcome = deploymentError
  ? `Partial: ${deploymentError.message}`
  : "Local XPI and all-profile Nightly policies staged; activation pending browser restart.";
writeFileSync(
  statePath,
  `${JSON.stringify({ release, version, id: manifest.browser_specific_settings.gecko.id, revision, dirty, sha256, completedAt, outcome }, null, 2)}\n`,
);
const ledger = existsSync(ledgerPath)
  ? readFileSync(ledgerPath, "utf8")
  : "# Deployments\n\nNumbering begins with recorded history; earlier deployments have not been reconstructed.\n";
const deploymentNumber =
  Math.max(
    0,
    ...Array.from(ledger.matchAll(/^## Deployment (\d+)/gm), (match) =>
      Number(match[1]),
    ),
  ) + 1;
const entry = `\n## Deployment ${deploymentNumber}\n\n- Completed: ${completedAt}\n- Target: local macOS Firefox Nightly, all current-user profiles\n- Outcome: ${outcome}\n- Revision boundary: ${previous?.revision ?? "unknown"}..${revision}\n- Source: ${dirty ? "uncommitted working tree based on the to revision; the commit hash alone does not identify this build" : "clean working tree at the to revision"}\n- Artifact: Karakeep Local ${version}; SHA-256 \`${sha256}\`\n- Previous artifact: ${previous?.sha256 ?? "unknown"}\n- Summary: ${previous ? "Updated" : "Installed"} the local unsigned capture extension with a stable identity and startup updates across Nightly profiles.\n`;
if (!existsSync(ledgerPath)) writeFileSync(ledgerPath, ledger);
appendFileSync(ledgerPath, entry);
if (deploymentError) throw deploymentError;

console.log(`\nKarakeep Local ${version} is ready for Nightly's next restart.`);
console.log(`XPI: ${packagePath}`);
console.log(`Deployment ${deploymentNumber}: ${ledgerPath}`);
