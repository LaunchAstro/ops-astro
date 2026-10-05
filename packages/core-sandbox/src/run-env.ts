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
// fixed value: a record naming HOME gets B3's.

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

/** `NAME=value` items as pairs; the base image's config writes no other form. */
function pairs(env: readonly string[]): Pair[] {
  return env.map((item) => {
    const at = item.indexOf('=');
    if (at < 1) throw new Error('B3 reads the base image variables as NAME=value');
    return [item.slice(0, at), item.slice(at + 1)];
  });
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
): string[] {
  return exact([S1_FIXED, pairs(base), record.buildEnv]);
}

export function s2Env(base: readonly string[]): string[] {
  return exact([S2_FIXED, pairs(base)]);
}
