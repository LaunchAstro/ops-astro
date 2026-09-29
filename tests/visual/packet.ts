// SPDX-License-Identifier: AGPL-3.0-only
//
// The packet: what a visual comparison is pinned to, and the checks that
// refuse a run when any pin moved (spike RN-08). The renderer identity sits
// beside the tolerance, so a different browser build, headless mode, scale
// factor, operating system or bundled font refuses the same way an edited
// tolerance does. The pinned mockup is a git tree hash, and the harness
// serves the mockup's bytes out of that tree, never out of a working copy, so
// a changed byte cannot reach a capture without changing the hash.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, platform, release } from 'node:os';
import { dirname } from 'node:path';
import type { Browser } from 'playwright';
import { assertTolerance, type Tolerance } from './compare.ts';

export type Renderer = {
  playwright: string;
  browser: string;
  browserRevision: string;
  browserBuild: string;
  deviceScaleFactor: number;
  os: string;
};
export type Packet = {
  mockup: { commit: string; tree: string };
  renderer: Renderer;
  tolerance: Tolerance;
  assetsDigest: string;
  widths: number[];
  height: number;
  themes: { light: string; dark: string };
  themeKey: string;
  clock: string;
  external: Record<string, string>;
};
export type Asset = {
  name: string;
  kind: string;
  file?: string;
  url?: string;
  sha256?: string;
  weight?: string;
  licence: string;
  refused?: string;
};

export const visualDir: string = new URL('.', import.meta.url).pathname;
export const assetsDir: string = `${visualDir}assets`;
/** Where the fetched font bytes live; gitignored, verified on every read. */
export const fontCache: string = new URL('../../.local/visual-assets', import.meta.url).pathname;
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

export function readPacket(): Packet {
  const packet = JSON.parse(readFileSync(`${visualDir}packet.json`, 'utf8')) as Packet;
  assertTolerance(packet.tolerance);
  return packet;
}

export function readAssets(): { assets: Asset[] } {
  return JSON.parse(readFileSync(`${assetsDir}/assets.json`, 'utf8')) as { assets: Asset[] };
}

/** The renderer this process is about to capture with. */
export function liveRenderer(browser: Browser, mode: Mode): Renderer {
  const require = createRequire(import.meta.url);
  // playwright-core is playwright's own dependency, so it resolves from there.
  const fromPlaywright = createRequire(require.resolve('playwright/package.json'));
  const corePath = dirname(fromPlaywright.resolve('playwright-core/package.json'));
  const core = JSON.parse(readFileSync(`${corePath}/browsers.json`, 'utf8')) as {
    browsers: { name: string; revision: string }[];
  };
  const shell = core.browsers.find((b) => b.name === 'chromium-headless-shell');
  return rendererOf(
    {
      playwright: (require('playwright/package.json') as { version: string }).version,
      browser: 'chromium-headless-shell',
      browserRevision: shell?.revision ?? 'unknown',
      browserBuild: browser.version(),
      deviceScaleFactor: 1,
      os: `${platform()} ${release()} ${arch()}`,
    },
    mode,
  );
}

/**
 * How the browser is launched. The renderer identity names the mode, so a
 * headed or new-headless run refuses until it is measured once and recorded
 * (MP-1-7; spike RN-08).
 */
export type Mode = { headless: boolean; channel?: string };
export const MODE: Mode = { headless: true };

/** The identity a launch mode captures with: only headless with no channel is the shell. */
export function rendererOf(base: Renderer, mode: Mode): Renderer {
  const shell = mode.headless && mode.channel === undefined;
  return { ...base, browser: shell ? 'chromium-headless-shell' : (mode.channel ?? 'chromium') };
}

export function checkRenderer(packet: Packet, live: Renderer): void {
  for (const key of Object.keys(packet.renderer) as (keyof Renderer)[]) {
    if (live[key] !== packet.renderer[key]) {
      throw new Error(
        `visual: renderer ${key} is ${String(live[key])}, the packet pins ` +
          `${String(packet.renderer[key])}; re-measure once and record it, or run on the pinned renderer`,
      );
    }
  }
}

/** Returns the pinned tree when the commit still names it; refuses otherwise. */
export function checkMockupTree(dir: string, pin: Packet['mockup']): string {
  let tree = '';
  try {
    tree = execFileSync('git', ['-C', dir, 'rev-parse', '--verify', `${pin.commit}^{tree}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error(`visual: the pinned mockup commit ${pin.commit} is not in ${dir}`);
  }
  if (tree !== pin.tree) {
    throw new Error(`visual: the pinned mockup changed: tree ${tree}, pinned ${pin.tree}`);
  }
  return tree;
}

/** Refuses bytes that are not the recorded ones, naming the file. */
export function verifyBytes(asset: Asset, bytes: Buffer): void {
  const actual = sha256(bytes);
  if (actual !== asset.sha256) {
    throw new Error(
      `visual: bundled ${String(asset.file)} is ${actual}, recorded ${String(asset.sha256)}`,
    );
  }
}

/**
 * The bundle: each font's bytes, fetched once from its pinned address into
 * the gitignored cache and verified against its recorded digest before any
 * use. The public tree holds no binary file (public-content policy), so the
 * records and licence texts are committed and the bytes are pinned by digest.
 */
export async function fetchAssets(
  manifest: { assets: Asset[] } = readAssets(),
  packet: Packet = readPacket(),
): Promise<void> {
  // The records are checked against the packet before anything is fetched, so
  // an edited address or file name is refused without a request leaving.
  checkRecords(packet, manifest);
  const fetchOne = async (asset: Asset, file: string, url: string): Promise<void> => {
    const path = `${fontCache}/${file}`;
    if (existsSync(path)) return verifyBytes(asset, readFileSync(path));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`visual: ${url} answered ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    verifyBytes(asset, bytes);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  };
  await Promise.all(
    manifest.assets.map((a) =>
      a.file === undefined || a.url === undefined ? undefined : fetchOne(a, a.file, a.url),
    ),
  );
}

/** The asset records are the ones the packet pins. */
function checkRecords(packet: Packet, manifest: { assets: Asset[] }): void {
  const digest = sha256(JSON.stringify(manifest.assets));
  if (digest !== packet.assetsDigest) {
    throw new Error(
      `visual: the asset records are ${digest}, the packet pins ${packet.assetsDigest}`,
    );
  }
}

/** The records match the packet, and every cached byte matches its record. */
export function checkAssets(packet: Packet, manifest: { assets: Asset[] } = readAssets()): void {
  checkRecords(packet, manifest);
  for (const asset of manifest.assets) {
    const path = `${fontCache}/${String(asset.file)}`;
    if (asset.file !== undefined && existsSync(path)) verifyBytes(asset, readFileSync(path));
  }
}
