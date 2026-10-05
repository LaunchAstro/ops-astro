// SPDX-License-Identifier: AGPL-3.0-only
//
// Whether a test that reads the built web bundle must build it first, and
// whether the bundle it holds is whole enough to read.
//
// `pnpm check` builds apps/web/dist before its tests, and several tests copy
// that bundle while others run beside them. A test that rebuilt it regardless
// would empty it under them (scripts/build.mjs clears the directory first). So
// scripts/check.mjs hands every step after its build the stamp that build
// wrote, in CHECK_WEB_BUILD, and a bundle carrying exactly that stamp is kept,
// a changed tree's included: the check built this tree moments ago in this
// run. Anything else is rebuilt: no variable (a run outside the check, which
// cannot know who wrote apps/web/dist, a gitignored directory), no bundle, a
// bundle with no stamp or another one. A stamp alone proves only that a
// stamp file is there, so the scan also wants the bundle's module graph and a
// script before it trusts finding nothing.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readStamp } from '../../apps/web/build-stamp.ts';

/** The variable scripts/check.mjs sets to the stamp its build step wrote. */
export const BUILT_VARIABLE = 'CHECK_WEB_BUILD';

/** True when `dist` must be rebuilt, given the build `pnpm check` names in `built`, if any. */
export function needsBuild(dist: string, built?: string): boolean {
  return built === undefined || built === '' || readStamp(dist) !== built;
}

/** What a built bundle must hold for an empty scan of it to mean anything, and `dist` lacks. */
export function missingFromBundle(dist: string): string[] {
  const missing: string[] = [];
  if (!existsSync(join(dist, 'module-graph.json'))) missing.push('module-graph.json');
  const assets = join(dist, 'assets');
  const scripts = existsSync(assets) ? readdirSync(assets).filter((f) => f.endsWith('.js')) : [];
  if (scripts.length === 0) missing.push('a .js file in assets/');
  return missing;
}
