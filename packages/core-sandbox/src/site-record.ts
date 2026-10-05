// SPDX-License-Identifier: AGPL-3.0-only
//
// I6 (docs/plan/sandbox-contract.md, section 3): a site record, changed
// only through a reviewed change, read as strict JSON with exactly its ten
// keys. The build command is the one allowed argv; the output directory is
// `dist`; the Node version is a plain x.y.z. A build variable is named
// `PUBLIC_...`, which Astro prints into pages and so can never hold a
// secret, or is a name B3 fixes and whose value B3 gives; its value is
// printable ASCII. The private scopes are npm scopes, and the content
// allow-list is a subset of I1's directories and extensions. `buildFormat`,
// `trailingSlash` and `output` are held for the caller (O4), `output` static
// only. A record that breaks any of this is `internal`: the launcher builds
// no site from it.

import { NPM_SCOPE } from './lockfile.ts';
import { fault, type SandboxResult } from './refusal.ts';
import { S1_FIXED_NAMES } from './run-env.ts';
import { hasExactKeys, isJsonObject, type Json, parseStrictJson } from './strict-json.ts';

export type SiteRecord = {
  readonly buildCommand: readonly string[];
  readonly outputDirectory: 'dist';
  readonly nodeVersion: string;
  readonly buildEnv: readonly (readonly [string, string])[];
  readonly scopes: readonly string[];
  readonly contentDirectories: readonly string[];
  readonly contentExtensions: readonly string[];
  readonly buildFormat: 'directory' | 'file' | 'preserve';
  readonly trailingSlash: 'always' | 'never' | 'ignore';
  readonly output: 'static';
};

const KEYS = [
  'buildCommand',
  'outputDirectory',
  'nodeVersion',
  'buildEnv',
  'scopes',
  'contentDirectories',
  'contentExtensions',
  'buildFormat',
  'trailingSlash',
  'output',
];
const BUILD_COMMAND = ['npm', 'run', 'build'];
const NODE_VERSION = /^(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})$/u;
const PUBLIC_NAME = /^PUBLIC_[A-Z0-9_]+$/u;
const ENV_VALUE = /^[ -~]{0,1024}$/u;
const MAX_ENV = 32;
/** I1's content allow-list; a record lists a subset of each. */
export const CONTENT_DIRECTORIES: readonly string[] = [
  'src/pages/',
  'src/content/',
  'src/components/',
];
export const CONTENT_EXTENSIONS: readonly string[] = ['.astro', '.md', '.mdx'];
const BUILD_FORMATS = ['directory', 'file', 'preserve'] as const;
const TRAILING_SLASHES = ['always', 'never', 'ignore'] as const;

/** The strings of `value` when it is a list of distinct strings that each pass `fits`. */
function distinct(value: Json | undefined, fits: (item: string) => boolean): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter((item): item is string => typeof item === 'string' && fits(item));
  return items.length === value.length && new Set(items).size === items.length ? items : null;
}

const oneOf = <T extends string>(allowed: readonly T[], value: Json | undefined): T | null =>
  allowed.find((item) => item === value) ?? null;

const isBuildCommand = (value: Json | undefined): boolean =>
  Array.isArray(value) &&
  value.length === BUILD_COMMAND.length &&
  value.every((part, at) => part === BUILD_COMMAND[at]);

function buildEnv(value: Json | undefined): [string, string][] | null {
  if (!isJsonObject(value)) return null;
  const env = Object.entries(value);
  if (env.length > MAX_ENV) return null;
  const pairs: [string, string][] = [];
  for (const [name, item] of env) {
    if (!PUBLIC_NAME.test(name) && !S1_FIXED_NAMES.has(name)) return null;
    if (typeof item !== 'string' || !ENV_VALUE.test(item)) return null;
    pairs.push([name, item]);
  }
  return pairs;
}

export function readSiteRecord(bytes: Uint8Array): SandboxResult<{ record: SiteRecord }> {
  const read = parseStrictJson(bytes);
  if (!read.ok) return read;
  const value = read.value;
  if (!isJsonObject(value) || !hasExactKeys(value, KEYS)) return fault('site record');
  const env = buildEnv(value['buildEnv']);
  if (env === null) return fault('record env');
  const nodeVersion = value['nodeVersion'];
  const scopes = distinct(value['scopes'], (item) => NPM_SCOPE.test(item));
  const directories = distinct(value['contentDirectories'], (item) =>
    CONTENT_DIRECTORIES.includes(item),
  );
  const extensions = distinct(value['contentExtensions'], (item) =>
    CONTENT_EXTENSIONS.includes(item),
  );
  const buildFormat = oneOf(BUILD_FORMATS, value['buildFormat']);
  const trailingSlash = oneOf(TRAILING_SLASHES, value['trailingSlash']);
  if (
    !isBuildCommand(value['buildCommand']) ||
    value['outputDirectory'] !== 'dist' ||
    typeof nodeVersion !== 'string' ||
    !NODE_VERSION.test(nodeVersion) ||
    scopes === null ||
    directories === null ||
    directories.length === 0 ||
    extensions === null ||
    extensions.length === 0 ||
    buildFormat === null ||
    trailingSlash === null ||
    value['output'] !== 'static'
  )
    return fault('site record');
  return {
    ok: true,
    record: {
      buildCommand: BUILD_COMMAND,
      outputDirectory: 'dist',
      nodeVersion,
      buildEnv: env,
      scopes,
      contentDirectories: directories,
      contentExtensions: extensions,
      buildFormat,
      trailingSlash,
      output: 'static',
    },
  };
}
