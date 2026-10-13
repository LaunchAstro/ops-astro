// SPDX-License-Identifier: AGPL-3.0-only
//
// The hosted presets: `--env sandbox|production` (or `OPS_ASTRO_ENV`) names an
// app origin, and the API, the hand-off's pages and the sign-in all follow it.
// A preset holds the origin and nothing else. `login` asks that origin where
// to sign in (`GET /api/sign-in`, the web's first call, `apps/web/src/main.tsx`),
// so no issuer or publishable key is written down here or saved anywhere.
//
// A preset replaces the hand-set addresses rather than mixing with them: a
// bearer signed in for one origin must not be sent to another by a leftover
// setting, so a preset beside any of them is refused, naming both.

import { unredirected } from './client.ts';

/** Each preset's app origin. */
export const PRESETS: Readonly<Record<string, string>> = {
  sandbox: 'https://app.opsastro.com',
  production: 'https://ops.agencyastro.com',
};

export interface Preset {
  readonly name: string;
  readonly origin: string;
}

/** The settings a preset replaces, as a person would have typed them. */
const HAND_SET_FLAGS = ['api', 'gotrue', 'web'] as const;
const HAND_SET_ENV = [
  'OPS_ASTRO_API_URL',
  'OPS_ASTRO_GOTRUE_URL',
  'OPS_ASTRO_WEB_URL',
  'SUPABASE_PUBLISHABLE_KEY',
] as const;

const given = (value: string | true | undefined): boolean => value !== undefined && value !== '';

/**
 * The preset `--env` or `OPS_ASTRO_ENV` names, or none. Throws, with words for
 * the caller, when the name is not a preset or a hand-set address sits beside it.
 */
export function presetOf(
  flags: Readonly<Record<string, string | true>>,
  env: Readonly<Record<string, string | undefined>>,
): Preset | undefined {
  const flag = flags['env'];
  const selector = given(flag)
    ? '--env'
    : given(env['OPS_ASTRO_ENV'])
      ? 'OPS_ASTRO_ENV'
      : undefined;
  if (selector === undefined) return undefined;
  const name = String(selector === '--env' ? flag : env['OPS_ASTRO_ENV']);
  const origin = PRESETS[name];
  if (origin === undefined) {
    throw new Error(`${selector} ${name} is not a preset; use sandbox or production`);
  }
  const mixed = [
    ...HAND_SET_FLAGS.filter((one) => given(flags[one])).map((one) => `--${one}`),
    ...HAND_SET_ENV.filter((one) => given(env[one])),
  ];
  if (mixed.length > 0) {
    throw new Error(
      `${selector} ${name} sets the address; leave out ${mixed.join(', ')} or drop ${selector}`,
    );
  }
  return { name, origin };
}

/**
 * Where the app at `origin` signs people in, as it tells the web: an https
 * issuer and the publishable key, or nothing when it does not say. A redirect
 * is never followed, so nothing is asked of an origin the preset did not name.
 */
export async function signInAddress(
  origin: string,
): Promise<{ readonly issuer: string; readonly key: string | undefined } | undefined> {
  try {
    const answer = await unredirected(`${origin}/api/sign-in`);
    if (!answer.ok) return undefined;
    const body = (await answer.json()) as { issuer?: unknown; key?: unknown };
    if (typeof body.issuer !== 'string' || URL.parse(body.issuer)?.protocol !== 'https:') {
      return undefined;
    }
    return { issuer: body.issuer, key: typeof body.key === 'string' ? body.key : undefined };
  } catch {
    return undefined;
  }
}
