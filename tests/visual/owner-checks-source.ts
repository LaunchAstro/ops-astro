// SPDX-License-Identifier: AGPL-3.0-only
//
// Where the owner-check films are recorded (ops-astro#1747): the deployed
// made-up build on app.opsastro.com, signed in with the made-up logins from
// the environment. `--local` films a local copy over the made-up reads
// instead, for working on the steps; its films are not the pack. No other
// host is filmed, so the real-data site (ops.agencyastro.com) never is.

export const DEPLOYED: URL = new URL('https://app.opsastro.com');

export type Source = { readonly kind: 'deployed'; readonly app: URL } | { readonly kind: 'local' };

export function sourceOf(args: readonly string[]): Source {
  return args.includes('--local') ? { kind: 'local' } : { kind: 'deployed', app: DEPLOYED };
}

export interface Login {
  readonly email: string;
  readonly password: string;
  readonly business: string;
}

/**
 * A made-up login from the environment: `OWNER_CHECK_<WHO>_EMAIL` and
 * `_PASSWORD`, with `OWNER_CHECK_BUSINESS`. Its values are typed into the
 * sign-in form and never printed.
 */
export function loginOf(
  who: 'OWNER' | 'TEAMMATE',
  env: NodeJS.ProcessEnv = process.env,
): Login | undefined {
  const email = env[`OWNER_CHECK_${who}_EMAIL`];
  const password = env[`OWNER_CHECK_${who}_PASSWORD`];
  const business = env['OWNER_CHECK_BUSINESS'];
  if (!email || !password || !business) return undefined;
  return { email, password, business };
}
