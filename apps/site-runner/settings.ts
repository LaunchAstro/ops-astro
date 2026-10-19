// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner's settings: one JSON file named by `SITE_RUNNER_SETTINGS`,
// readable by its owner alone, holding the names below as keys. The agent's
// password and the database login's address live there and nowhere else: not
// in the plist, not in the environment, never printed. A missing or malformed
// setting is named, never shown.
//
// `SITE_RUNNER_SITE` is the one site the runner acts for (#1693): an object
// with exactly `business`, `holder`, `repository`, `defaultBranch`, `project`
// and `pages`, each page an exact https address and its source file under
// `src/pages/`. The holder is the business or one of its clients; a client is
// confirmed by one read at start-up (`holderRefuses`). `SITE_RUNNER_LOCATE_ONLY`
// set to `1` runs the locate alone, with custody holding read routes only.

import { readFileSync, statSync } from 'node:fs';
import { isBusinessId, isUuid } from '../../packages/core-records/src/index.ts';
import type { ConfiguredSite } from './configured.ts';

export const SETTINGS = 'SITE_RUNNER_SETTINGS';

const REQUIRED = [
  'OPS_ASTRO_API_URL',
  'OPS_ASTRO_BUSINESS',
  'OPS_ASTRO_BUSINESS_ID',
  'OPS_ASTRO_EMAIL',
  'OPS_ASTRO_PASSWORD',
  'OPS_ASTRO_GOTRUE_URL',
  'SITE_RUNNER_DATABASE_URL',
  'SITE_RUNNER_CREDENTIALS_FILE',
  'SITE_RUNNER_SITE',
] as const;

/** The catalogued hosts, and nothing else, as custody's two destinations. */
export const SOURCE_ORIGIN = 'https://api.github.com';
export const HOSTING_ORIGIN = 'https://api.vercel.com';

const TLS_MODES = new Set(['require', 'verify-ca', 'verify-full']);

export type Settings = Readonly<Record<(typeof REQUIRED)[number], string>> & {
  readonly providerKey: string;
  readonly heartbeat: string | undefined;
  /** The configured site's page addresses: the capture fence's agency pages. */
  readonly pages: readonly string[];
  readonly site: ConfiguredSite;
  /** Locate only: no claims taken, and custody routes nothing but reads. */
  readonly locateOnly: boolean;
};

const SITE_KEYS = ['business', 'holder', 'repository', 'defaultBranch', 'project', 'pages'];
const PAGE_KEYS = ['pageUrl', 'path'];
/** One plain path or name segment, as the guarded call accepts it. */
const SEGMENT = /^[A-Za-z0-9._-]+$/u;
const plain = (value: unknown): value is string =>
  typeof value === 'string' && SEGMENT.test(value) && value !== '.' && value !== '..';
/** A page source (the envelope's own rule): plain segments under `src/pages/`, an Astro or Markdown file. */
const pageSource = (path: unknown): boolean => {
  if (typeof path !== 'string') return false;
  const [top, pages, ...rest] = path.split('/');
  return (
    top === 'src' &&
    pages === 'pages' &&
    rest.length > 0 &&
    rest.every((segment) => /^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(segment)) &&
    /\.(?:astro|md)$/u.test(rest.at(-1) ?? '')
  );
};
/** An exact https address: the fence compares the catalogued page byte for byte. */
const exactPage = (page: unknown): boolean =>
  typeof page === 'string' &&
  URL.parse(page)?.protocol === 'https:' &&
  URL.parse(page)?.href === page;

const keysExactly = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const named = (key: string, why: string): string => `SITE_RUNNER_SITE.${key} ${why}`;

/** The pages, or the one line naming the first that is not an exact page with its source file. */
function pagesOf(value: unknown): ConfiguredSite['pages'] | string {
  if (!Array.isArray(value) || value.length === 0) return named('pages', 'is not a list of pages');
  for (const page of value as unknown[]) {
    if (!keysExactly(page, PAGE_KEYS))
      return named('pages', 'holds a page without exactly pageUrl and path');
    if (!exactPage(page['pageUrl'])) return named('pages.pageUrl', 'is not an exact https page');
    if (!pageSource(page['path']))
      return named('pages.path', 'is not a page source under src/pages/');
  }
  return (value as { pageUrl: string; path: string }[]).map(({ pageUrl, path }) => ({
    pageUrl,
    path,
  }));
}

/** The configured site, or the one line naming the key that is missing, unknown or bad. */
export function siteFrom(text: string, business: string): ConfiguredSite | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'SITE_RUNNER_SITE is not a JSON object';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return 'SITE_RUNNER_SITE is not a JSON object';
  const site = value as Record<string, unknown>;
  const missing = SITE_KEYS.find((key) => !Object.hasOwn(site, key));
  if (missing !== undefined) return named(missing, 'is missing');
  const unknown = Object.keys(site).find((key) => !SITE_KEYS.includes(key));
  if (unknown !== undefined) return named(unknown, 'is not a key the site holds');
  if (site['business'] !== business) return named('business', 'is not OPS_ASTRO_BUSINESS_ID');
  const holder = site['holder'];
  if (typeof holder !== 'string' || !isUuid(holder) || holder !== holder.toLowerCase())
    return named('holder', 'is not the business or a client id');
  const repository = site['repository'];
  const parts = typeof repository === 'string' ? repository.split('/') : [];
  if (parts.length !== 2 || !parts.every((part) => plain(part)))
    return named('repository', 'is not an owner/name repository');
  if (!plain(site['defaultBranch'])) return named('defaultBranch', 'is not a branch name');
  if (!plain(site['project'])) return named('project', 'is not a project id');
  const pages = pagesOf(site['pages']);
  if (typeof pages === 'string') return pages;
  return {
    holder,
    repository: repository as string,
    defaultBranch: site['defaultBranch'] as string,
    project: site['project'] as string,
    pages,
  };
}

/** The settings, or the one line naming what is missing or malformed. */
export function settingsFrom(env: Readonly<Record<string, string | undefined>>): Settings | string {
  const missing = REQUIRED.filter((name) => (env[name] ?? '') === '');
  if (missing.length > 0) return `missing ${missing.join(', ')}`;
  const value = (name: (typeof REQUIRED)[number]) => env[name] ?? '';
  if (!isBusinessId(value('OPS_ASTRO_BUSINESS_ID')))
    return 'OPS_ASTRO_BUSINESS_ID is not a business id';
  const database = URL.parse(value('SITE_RUNNER_DATABASE_URL'));
  const modes = database?.searchParams.getAll('sslmode') ?? [];
  if (modes.length !== 1 || !TLS_MODES.has(modes[0] ?? '') || database?.searchParams.has('ssl'))
    return 'SITE_RUNNER_DATABASE_URL does not require TLS (add ?sslmode=require or stricter)';
  const site = siteFrom(value('SITE_RUNNER_SITE'), value('OPS_ASTRO_BUSINESS_ID'));
  if (typeof site === 'string') return site;
  const locate = env['SITE_RUNNER_LOCATE_ONLY'] ?? '';
  if (locate !== '' && locate !== '1') return 'SITE_RUNNER_LOCATE_ONLY is not 1';
  const settings = Object.fromEntries(REQUIRED.map((name) => [name, value(name)]));
  return {
    ...(settings as Readonly<Record<(typeof REQUIRED)[number], string>>),
    providerKey: env['SUPABASE_PUBLISHABLE_KEY'] ?? '',
    heartbeat: env['SITE_RUNNER_HEARTBEAT_URL'],
    pages: site.pages.map((page) => page.pageUrl),
    site,
    locateOnly: locate === '1',
  };
}

/** The settings from the file `SITE_RUNNER_SETTINGS` names, or the one line saying why not. */
export function readSettings(env: Readonly<Record<string, string | undefined>>): Settings | string {
  const file = env[SETTINGS] ?? '';
  if (file === '') return `${SETTINGS} names no file`;
  let parsed: unknown;
  try {
    if ((statSync(file).mode & 0o077) !== 0) return 'the settings file is readable by others';
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return 'the settings file could not be read';
  }
  // The site may be written as an object in the file; it is read as its JSON text.
  const fields = (typeof parsed === 'object' && parsed !== null ? Object.entries(parsed) : []).map(
    ([name, value]): [string, unknown] =>
      name === 'SITE_RUNNER_SITE' && typeof value === 'object' && value !== null
        ? [name, JSON.stringify(value)]
        : [name, value],
  );
  if (fields.length === 0 || fields.some(([, value]) => typeof value !== 'string'))
    return 'the settings file is not an object of strings';
  return settingsFrom(Object.fromEntries(fields) as Record<string, string>);
}
