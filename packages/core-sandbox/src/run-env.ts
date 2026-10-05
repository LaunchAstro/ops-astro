// SPDX-License-Identifier: AGPL-3.0-only
//
// B3 (docs/plan/sandbox-contract.md, section 4): the environment, exact per
// class. S1 gets PATH, HOME, HOSTNAME, NODE_ENV and
// ASTRO_TELEMETRY_DISABLED at fixed values, then the base image's own
// variables (as its pinned config gives them), then the site record's build
// variables. S2 gets the same fixed list without NODE_ENV, the npm
// configuration the launcher writes (offline, ignore-scripts, cache path)
// and the base image's own variables, and no site variable. A name keeps the
// first value listed, so neither the base image nor a record can change a
// fixed value: a record naming HOME gets B3's. A base variable is an
// uppercase NAME=value of printable ASCII and never npm configuration: npm
// reads every `npm_config_` variable whatever its case and lets the later one
// win, so a base image could otherwise undo S2's offline or ignore-scripts.
// A base list that breaks this is `internal`.

import { fault, type SandboxResult } from './refusal.ts';

type Pair = readonly [string, string];

const PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const COMMON: readonly Pair[] = [
  ['PATH', PATH],
  ['HOME', '/tmp/home'],
  ['HOSTNAME', 'sandbox'],
];
const S1_FIXED: readonly Pair[] = [
  ...COMMON,
  ['NODE_ENV', 'production'],
  ['ASTRO_TELEMETRY_DISABLED', '1'],
];
const S2_FIXED: readonly Pair[] = [
  ...COMMON,
  ['ASTRO_TELEMETRY_DISABLED', '1'],
  ['npm_config_offline', 'true'],
  ['npm_config_ignore_scripts', 'true'],
  ['npm_config_cache', '/tmp/npm-cache'],
];

/** The names S1 fixes; a site record may name one and gets B3's value (I6). */
export const S1_FIXED_NAMES: ReadonlySet<string> = new Set(S1_FIXED.map(([name]) => name));
/** Each class's fixed pairs as its `Env` list opens with them (the pin list, B3). */
export const S1_OPENING: readonly string[] = S1_FIXED.map(([name, value]) => `${name}=${value}`);
export const S2_OPENING: readonly string[] = S2_FIXED.map(([name, value]) => `${name}=${value}`);

const BASE_NAME = /^[A-Z_][A-Z0-9_]*$/u;
const VALUE = /^[ -~]*$/u;

/** A base image variable as a pair, or null when it breaks uppercase NAME=value or is npm's. */
export function basePair(item: string): Pair | null {
  const at = item.indexOf('=');
  const name = item.slice(0, at);
  const value = item.slice(at + 1);
  const fits = at > 0 && BASE_NAME.test(name) && VALUE.test(value);
  return fits && !name.toLowerCase().startsWith('npm_config_') ? [name, value] : null;
}

function pairs(env: readonly string[]): Pair[] | null {
  const read = env.map((item) => basePair(item));
  return read.every((pair) => pair !== null) ? read : null;
}

/** Each name once, at the first value listed. */
function exact(lists: readonly (readonly Pair[])[]): string[] {
  const seen = new Set<string>();
  const env: string[] = [];
  for (const [name, value] of lists.flat()) {
    if (seen.has(name)) continue;
    seen.add(name);
    env.push(`${name}=${value}`);
  }
  return env;
}

export function s1Env(
  base: readonly string[],
  record: { readonly buildEnv: readonly Pair[] },
): SandboxResult<{ env: string[] }> {
  const own = pairs(base);
  return own === null
    ? fault('base env')
    : { ok: true, env: exact([S1_FIXED, own, record.buildEnv]) };
}

export function s2Env(base: readonly string[]): SandboxResult<{ env: string[] }> {
  const own = pairs(base);
  return own === null ? fault('base env') : { ok: true, env: exact([S2_FIXED, own]) };
}
