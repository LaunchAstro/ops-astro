// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner's settings: one JSON file named by `SITE_RUNNER_SETTINGS`,
// readable by its owner alone, holding the names below as keys. The agent's
// password and the database login's address live there and nowhere else: not
// in the plist, not in the environment, never printed. A missing or malformed
// setting is named, never shown.

import { readFileSync, statSync } from 'node:fs';
import { isBusinessId } from '../../packages/core-records/src/index.ts';

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
  'SITE_RUNNER_PAGES',
] as const;

/** The catalogued hosts, and nothing else, as custody's two destinations. */
export const SOURCE_ORIGIN = 'https://api.github.com';
export const HOSTING_ORIGIN = 'https://api.vercel.com';

const TLS_MODES = new Set(['require', 'verify-ca', 'verify-full']);

export type Settings = Readonly<Record<(typeof REQUIRED)[number], string>> & {
  readonly providerKey: string;
  readonly heartbeat: string | undefined;
  readonly pages: readonly string[];
};

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
  const pages = value('SITE_RUNNER_PAGES')
    .split(',')
    .map((page) => page.trim());
  // Exact https addresses: the fence compares the catalogued page byte for byte.
  if (
    pages.some((page) => URL.parse(page)?.protocol !== 'https:' || URL.parse(page)?.href !== page)
  )
    return 'SITE_RUNNER_PAGES holds an address that is not an exact https page';
  const settings = Object.fromEntries(REQUIRED.map((name) => [name, value(name)]));
  return {
    ...(settings as Readonly<Record<(typeof REQUIRED)[number], string>>),
    providerKey: env['SUPABASE_PUBLISHABLE_KEY'] ?? '',
    heartbeat: env['SITE_RUNNER_HEARTBEAT_URL'],
    pages,
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
  const fields = typeof parsed === 'object' && parsed !== null ? Object.entries(parsed) : [];
  if (fields.length === 0 || fields.some(([, value]) => typeof value !== 'string'))
    return 'the settings file is not an object of strings';
  return settingsFrom(Object.fromEntries(fields) as Record<string, string>);
}
