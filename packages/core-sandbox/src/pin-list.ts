// SPDX-License-Identifier: AGPL-3.0-only
//
// The pin list (docs/plan/sandbox-contract.md, terms and B8): the file the
// socket proxy reads the pins from, written only by the deploy of a
// reviewed change, read as strict JSON with exactly `probe`, `base` and
// `sites`. The probe entry is one image id (S0 only). `base` holds one entry
// per known platform for the base-plus-entrypoint image, with the one S2
// `Env` list. Each site entry, keyed by a site id, holds its lockfile
// digest, its S1 image id, its attempt number, the site commit F2 builds and
// its S1 `Env` list; the image id is empty exactly while a pin is being
// made, and only then is the commit named. An `Env` list is `NAME=value`
// items of printable ASCII with distinct names. A file that breaks any of
// this is `internal`: the proxy admits no create from it.

import { fault, type SandboxResult } from './refusal.ts';
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
const SITE_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const ENV_ITEM = /^([A-Za-z_][A-Za-z0-9_]*)=[ -~]*$/u;
const PLATFORMS: ReadonlySet<string> = new Set(['linux/arm64', 'linux/amd64']);
const MAX_ATTEMPT = 2 ** 31 - 1;

const image = (value: Json | undefined): value is string =>
  typeof value === 'string' && IMAGE.test(value);

function envList(value: Json | undefined): string[] | null {
  if (!Array.isArray(value)) return null;
  const names = new Set<string>();
  const env: string[] = [];
  for (const item of value) {
    const name = typeof item === 'string' ? ENV_ITEM.exec(item)?.[1] : undefined;
    if (name === undefined || names.has(name)) return null;
    names.add(name);
    env.push(item as string);
  }
  return env;
}

function baseEntry(value: Json | undefined): BaseEntry | null {
  if (!hasExactKeys(value, ['image', 'env']) || !isJsonObject(value)) return null;
  const env = envList(value['env']);
  return image(value['image']) && env !== null ? { image: value['image'], env } : null;
}

function siteEntry(value: Json | undefined): SiteEntry | null {
  const keys = ['lockfile', 'image', 'attempt', 'commit', 'env'];
  if (!hasExactKeys(value, keys) || !isJsonObject(value)) return null;
  const { lockfile, attempt, commit } = value;
  const env = envList(value['env']);
  const making = value['image'] === '' && typeof commit === 'string' && COMMIT.test(commit);
  const pinned = image(value['image']) && commit === '';
  if (
    !image(lockfile) ||
    !(making || pinned) ||
    !Number.isSafeInteger(attempt) ||
    typeof attempt !== 'number' ||
    attempt < 1 ||
    attempt > MAX_ATTEMPT ||
    env === null
  )
    return null;
  return { lockfile, image: value['image'] as string, attempt, commit: commit as string, env };
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
    !image(probe['image']) ||
    base === null ||
    base.size === 0 ||
    sites === null
  )
    return fault('pin list');
  return { ok: true, pins: { probe: probe['image'], base, sites } };
}
