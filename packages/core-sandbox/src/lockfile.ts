// SPDX-License-Identifier: AGPL-3.0-only
//
// I5 (docs/plan/sandbox-contract.md, section 3): `site.prepare` accepts only
// a `package-lock.json` with `lockfileVersion` 3 and a `package.json` with no
// `packageManager` field. Every non-root package entry has a `sha512`
// integrity and a `resolved` URL of exactly one of two forms, built from the
// entry's own name and version; an alias, a link or any other host is a
// refusal. Both files are read with the strict JSON parser, `package.json`
// under its 1 MiB and the lockfile under its own 16 MB. A `resolved`
// value is compared whole against the form spelt from the entry's key and
// version, never matched by pattern, so no other URL can pass.

import { type Refused, type SandboxResult, type Why } from './refusal.ts';
import { type Json, MAX_JSON_BYTES, parseStrictJson } from './strict-json.ts';

/** npm's name grammar for new packages: lowercase, URL-safe, no leading `.` or `_`. */
const PART = '[a-z0-9~-][a-z0-9._~-]*';
const NAME = new RegExp(`^(?:@${PART}/)?${PART}$`, 'u');
const MAX_NAME = 214;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
// 64 bytes of sha512 in base64: 86 characters and `==`.
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const HEX40 = /^[0-9a-f]{40}$/u;
const ROOT = 'node_modules/';
const NESTED = '/node_modules/';
const REGISTRY = 'https://registry.npmjs.org/';
const GITHUB = 'https://npm.pkg.github.com/download/';

/** The lockfile's own cap, in bytes (decimal, inside S1's 50 MB input cap). */
export const LOCKFILE_CAP = 16_000_000;

const refusal = (why: Why): Refused => ({ ok: false, reason: 'lockfile refused', why });

type JsonObject = { readonly [key: string]: Json };
const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parse(text: string, maxBytes = MAX_JSON_BYTES): SandboxResult<{ object: JsonObject }> {
  const read = parseStrictJson(new TextEncoder().encode(text), { maxBytes });
  if (!read.ok) return refusal(read.why);
  return isObject(read.value) ? { ok: true, object: read.value } : refusal('lockfile entry');
}

/** The package name a `packages` key installs, or null when the key breaks the grammar. */
function nameOf(key: string): string | null {
  if (!key.startsWith(ROOT)) return null;
  const parts = key.slice(ROOT.length).split(NESTED);
  const fits = (part: string) => part.length <= MAX_NAME && NAME.test(part);
  return parts.every((part) => fits(part)) ? (parts.at(-1) ?? null) : null;
}

function resolvedFits(
  resolved: Json | undefined,
  name: string,
  version: string,
  scopes: readonly string[],
): boolean {
  if (typeof resolved !== 'string') return false;
  const base = name.slice(name.indexOf('/') + 1);
  if (resolved === `${REGISTRY}${name}/-/${base}-${version}.tgz`) return true;
  const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/')) : null;
  const prefix = `${GITHUB}${name}/${version}/`;
  return (
    scope !== null &&
    scopes.includes(scope) &&
    resolved.startsWith(prefix) &&
    HEX40.test(resolved.slice(prefix.length))
  );
}

function entryClause(key: string, entry: Json | undefined, scopes: readonly string[]): Why | null {
  const name = nameOf(key);
  if (name === null) return 'lockfile name';
  if (!isObject(entry)) return 'lockfile entry';
  if (Object.hasOwn(entry, 'link')) return 'lockfile link';
  if (Object.hasOwn(entry, 'name')) return 'lockfile alias';
  const version = entry['version'];
  if (typeof version !== 'string' || !VERSION.test(version)) return 'lockfile entry';
  const integrity = entry['integrity'];
  if (typeof integrity !== 'string' || !INTEGRITY.test(integrity)) return 'lockfile integrity';
  if (!resolvedFits(entry['resolved'], name, version, scopes)) return 'lockfile resolved';
  return null;
}

export function checkLockfile(
  packageJson: string,
  lockfile: string,
  scopes: readonly string[],
): SandboxResult<object> {
  const manifest = parse(packageJson);
  if (!manifest.ok) return manifest;
  if (Object.hasOwn(manifest.object, 'packageManager')) return refusal('package manager');
  const lock = parse(lockfile, LOCKFILE_CAP);
  if (!lock.ok) return lock;
  if (lock.object['lockfileVersion'] !== 3) return refusal('lockfile version');
  const packages = lock.object['packages'];
  if (!isObject(packages)) return refusal('lockfile entry');
  for (const [key, entry] of Object.entries(packages)) {
    if (key === '') continue;
    const clause = entryClause(key, entry, scopes);
    if (clause !== null) return refusal(clause);
  }
  return { ok: true };
}
