import { defineCommand } from "citty";
import { existsSync, mkdtempSync, renameSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { withErrors } from "../util/cli.ts";
import { KenError } from "../util/err.ts";
import pkg from "../../package.json" with { type: "json" };

const VERSION = pkg.version;
const DEFAULT_REPO = process.env.KEN_UPDATE_REPO || "prasann16/ken";

type Asset = { name: string; browser_download_url: string };
type Release = { tag_name: string; assets: Asset[] };

function platformTag(): { tag: string; dylibExt: "dylib" | "so" | "dll" } {
  const os = process.platform;
  const arch = process.arch;
  if (os === "darwin" && arch === "x64")   return { tag: "darwin-x64",   dylibExt: "dylib" };
  if (os === "darwin" && arch === "arm64") return { tag: "darwin-arm64", dylibExt: "dylib" };
  if (os === "linux"  && arch === "x64")   return { tag: "linux-x64",    dylibExt: "so" };
  if (os === "linux"  && arch === "arm64") return { tag: "linux-arm64",  dylibExt: "so" };
  if (os === "win32"  && arch === "x64")   return { tag: "windows-x64",  dylibExt: "dll" };
  throw new KenError("CONFIG", `unsupported platform: ${os}-${arch}`);
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => parseInt(n, 10));
  const pb = b.replace(/^v/, "").split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export const updateCmd = defineCommand({
  meta: {
    name: "update",
    description: "Check for and install a new ken release from GitHub",
  },
  args: {
    repo: { type: "string", description: "GitHub repo (e.g. user/ken). Else KEN_UPDATE_REPO env or default.", default: "" },
    check: { type: "boolean", description: "Only check for a new version; don't install.", default: false },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  run: withErrors(async (args) => {
    const repo = (args.repo as string) || DEFAULT_REPO;
    const { tag: platform, dylibExt } = platformTag();
    const assetName = `ken-${platform}.tar.gz`;

    if (!args.json) process.stdout.write(`current version: ${VERSION}\n`);

    let release: Release;
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { accept: "application/vnd.github+json" },
      });
      if (res.status === 404) {
        throw new KenError("NOT_FOUND", `no releases for ${repo}`, {
          hint: "create a GitHub Release with the tarball assets, or override the repo with --repo=<user>/<name>",
        });
      }
      if (!res.ok) throw new KenError("CONFIG", `GitHub API error ${res.status}`);
      release = (await res.json()) as Release;
    } catch (e) {
      if (e instanceof KenError) throw e;
      throw new KenError("CONFIG", `cannot reach GitHub: ${(e as Error).message}`);
    }

    const latest = release.tag_name.replace(/^v/, "");
    const cmp = compareVersions(latest, VERSION);

    if (cmp <= 0) {
      if (args.json) console.log(JSON.stringify({ current: VERSION, latest, update: false }));
      else process.stdout.write(`already on latest (${VERSION})\n`);
      return;
    }

    if (args.check) {
      if (args.json) console.log(JSON.stringify({ current: VERSION, latest, update: true }));
      else process.stdout.write(`update available: ${VERSION} → ${latest}\n`);
      return;
    }

    const asset = release.assets.find((a) => a.name === assetName);
    if (!asset) {
      throw new KenError("NOT_FOUND", `release ${release.tag_name} has no asset named ${assetName}`, {
        hint: `available assets: ${release.assets.map((a) => a.name).join(", ") || "(none)"}`,
      });
    }

    if (!args.json) process.stdout.write(`downloading ${assetName}...\n`);
    const dlRes = await fetch(asset.browser_download_url, { redirect: "follow" });
    if (!dlRes.ok) throw new KenError("CONFIG", `download failed: ${dlRes.status}`);
    const bytes = new Uint8Array(await dlRes.arrayBuffer());

    const stage = mkdtempSync(join(tmpdir(), "ken-update-"));
    const tarPath = join(stage, "release.tar.gz");
    await Bun.write(tarPath, bytes);

    if (!args.json) process.stdout.write(`extracting...\n`);
    const tarRes = spawnSync("tar", ["xzf", tarPath, "-C", stage], { stdio: "inherit" });
    if (tarRes.status !== 0) throw new KenError("CONFIG", `tar extract failed`);

    const extractedDir = join(stage, `ken-${platform}`);
    const newBin = join(extractedDir, "ken");
    const newDylib = join(extractedDir, `vec0.${dylibExt}`);
    if (!existsSync(newBin)) throw new KenError("NOT_FOUND", `extracted tarball missing ken binary at ${newBin}`);
    if (!existsSync(newDylib)) throw new KenError("NOT_FOUND", `extracted tarball missing vec0.${dylibExt}`);

    const binDir = dirname(process.execPath);
    const targetBin = join(binDir, "ken");
    const targetDylib = join(binDir, `vec0.${dylibExt}`);

    if (!args.json) process.stdout.write(`installing to ${binDir}...\n`);
    try {
      chmodSync(newBin, 0o755);
      renameSync(newBin, targetBin);
      renameSync(newDylib, targetDylib);
    } catch (e) {
      throw new KenError("CONFIG", `failed to install: ${(e as Error).message}`, {
        hint: `check write permission on ${binDir}; install to a writable dir like ~/.ken/bin`,
      });
    }

    if (args.json) console.log(JSON.stringify({ current: VERSION, latest, update: true, installed: true }));
    else process.stdout.write(`✓ updated ${VERSION} → ${latest}. restart any running ken processes.\n`);
  }),
});
