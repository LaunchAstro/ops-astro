// SPDX-License-Identifier: AGPL-3.0-only
//
// The pin list (docs/plan/sandbox-contract.md, terms and B8): the file the
// socket proxy reads the pins from, written only by the deploy of a
// reviewed change, read as strict JSON with exactly `probe`, `base` and
// `sites`. The probe entry is one image id (S0 only). `base` holds one entry
// per known platform for the base-plus-entrypoint image, with the one S2
// `Env` list. Each site entry, keyed by a site id, holds its lockfile
// digest, its S1 image id, its attempt number, the site commit the
// reproducibility check builds and its S1 `Env` list; the image id is empty
// exactly while a pin is being made, and only then is the commit named. An
// `Env` list opens with its class's fixed B3 pairs in order (S1 for a site,
// S2 for a base), then uppercase `NAME=value` items of printable ASCII, each
// name once and none of them npm configuration. A file that breaks any of
// this is `internal`: the proxy admits no create from it.

import { fault, type SandboxResult } from './refusal.ts';
import { basePair, S1_OPENING, S2_OPENING } from './run-env.ts';
import { hasExactKeys, isJsonObject, type Json, parseStrictJson } from './strict-json.ts';

export type SiteEntry = {
  readonly lockfile: string;
  readonly image: string;
  readonly attempt: number;
  readonly commit: string;
  readonly env: readonly string[];
};
export type BaseEntry = { readonly image: string; readonly env: readonly string[] };
export type PinList = {
  readonly probe: string;
  readonly base: ReadonlyMap<string, BaseEntry>;
  readonly sites: ReadonlyMap<string, SiteEntry>;
};

const IMAGE = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
/** A site id: lowercase letters and digits, inner hyphens, at most 63. */
export const SITE_ID: RegExp = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const PLATFORMS: ReadonlySet<string> = new Set(['linux/arm64', 'linux/amd64']);
const MAX_ATTEMPT = 2 ** 31 - 1;

const isImage = (value: Json | undefined): value is string =>
  typeof value === 'string' && IMAGE.test(value);

/**
 * An `Env` list that opens with its class's fixed B3 pairs, in order, followed
 * by base and record variables as `basePair` reads them, each name once: so no
 * spelling of npm's configuration can follow the opening.
 */
function envList(value: Json | undefined, opening: readonly string[]): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter((item): item is string => typeof item === 'string');
  if (items.length !== value.length || opening.some((item, at) => items[at] !== item)) return null;
  const names = new Set(opening.map((item) => item.slice(0, item.indexOf('='))));
  for (const item of items.slice(opening.length)) {
    const pair = basePair(item);
    if (pair === null || names.has(pair[0])) return null;
    names.add(pair[0]);
  }
  return items;
}

function baseEntry(value: Json | undefined): BaseEntry | null {
  if (!hasExactKeys(value, ['image', 'env']) || !isJsonObject(value)) return null;
  const { image: id } = value;
  const env = envList(value['env'], S2_OPENING);
  return isImage(id) && env !== null ? { image: id, env } : null;
}

function siteEntry(value: Json | undefined): SiteEntry | null {
  const keys = ['lockfile', 'image', 'attempt', 'commit', 'env'];
  if (!hasExactKeys(value, keys) || !isJsonObject(value)) return null;
  const { lockfile, image: id, attempt, commit } = value;
  const env = envList(value['env'], S1_OPENING);
  if (typeof id !== 'string' || typeof commit !== 'string' || typeof attempt !== 'number')
    return null;
  const making = id === '' && COMMIT.test(commit);
  const pinned = isImage(id) && commit === '';
  if (
    !isImage(lockfile) ||
    !(making || pinned) ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    attempt > MAX_ATTEMPT ||
    env === null
  )
    return null;
  return { lockfile, image: id, attempt, commit, env };
}

/** The entries of an object whose keys each pass `fits` and whose values each read. */
function entries<T>(
  value: Json | undefined,
  fits: (key: string) => boolean,
  read: (entry: Json) => T | null,
): Map<string, T> | null {
  if (!isJsonObject(value)) return null;
  const map = new Map<string, T>();
  for (const [key, entry] of Object.entries(value)) {
    const parsed = fits(key) ? read(entry) : null;
    if (parsed === null) return null;
    map.set(key, parsed);
  }
  return map;
}

export function readPinList(bytes: Uint8Array): SandboxResult<{ pins: PinList }> {
  const read = parseStrictJson(bytes);
  if (!read.ok) return read;
  const value = read.value;
  if (!hasExactKeys(value, ['probe', 'base', 'sites']) || !isJsonObject(value))
    return fault('pin list');
  const probe = value['probe'];
  const base = entries(value['base'], (key) => PLATFORMS.has(key), baseEntry);
  const sites = entries(value['sites'], (key) => SITE_ID.test(key), siteEntry);
  if (
    !hasExactKeys(probe, ['image']) ||
    !isJsonObject(probe) ||
    !isImage(probe['image']) ||
    base === null ||
    base.size === 0 ||
    sites === null
  )
    return fault('pin list');
  return { ok: true, pins: { probe: probe['image'], base, sites } };
}
