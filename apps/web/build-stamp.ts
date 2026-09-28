// SPDX-License-Identifier: AGPL-3.0-only
//
// The version stamp: which build this is, in one string.
//
// The identifier is the commit the build was made from, twelve hex digits,
// with `-dirty` when the working tree differed from that commit. It is what the
// page shows in the rail, what `build.json` in the artefact holds, and what a
// promotion step records, so all three are this one function's answer.
//
// It is read from git and nowhere else. A build outside a checkout has no
// honest identifier, so it is refused rather than given a placeholder that
// reads like a version.
//
// Three readers, one module: `vite.config.ts` stamps the page and the artefact,
// `scripts/build.mjs` checks the artefact carries the stamp it asked for, and
// the browser harness compares the served page against the checkout.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The file the build writes into its output directory. */
export const STAMP_FILE = 'build.json';
/** The `<meta name>` the build writes into the entry document. */
export const STAMP_META = 'ops-astro-build';
/** How `scripts/build.mjs` hands Vite the identifier it computed once. */
export const STAMP_VARIABLE = 'OPS_ASTRO_BUILD_ID';
/** An identifier and nothing else: no tag, no date, no free text. */
export const STAMP_SHAPE: RegExp = /^[0-9a-f]{12}(?:-dirty)?$/u;

/** The build identifier of the checkout at `cwd`. Throws outside one. */
export function buildIdentifier(cwd: string): string {
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let head: string;
  let status: string;
  try {
    head = git('rev-parse', 'HEAD').trim();
    status = git('status', '--porcelain');
  } catch {
    throw new Error(`build identifier: ${cwd} is not a git checkout, so no build can be named`);
  }
  return `${head.slice(0, 12)}${status.trim() === '' ? '' : '-dirty'}`;
}

/** The identifier an artefact carries, or undefined when it has none it can prove. */
export function readStamp(directory: string): string | undefined {
  try {
    const stamp: unknown = JSON.parse(readFileSync(join(directory, STAMP_FILE), 'utf8'));
    const build = (stamp as { build?: unknown } | null)?.build;
    return typeof build === 'string' && STAMP_SHAPE.test(build) ? build : undefined;
  } catch {
    return undefined;
  }
}
