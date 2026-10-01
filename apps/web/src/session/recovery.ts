// SPDX-License-Identifier: AGPL-3.0-only
//
// A forgotten password (C40): the three calls the two pages make.
//
// The ask goes to the API with the address in the body and no credential, and
// the API answers the same for every address, so there is nothing here to read
// from its answer but whether it arrived. The reset link's token is verified
// at the login provider's own endpoint, as sign-in posts its credentials to
// the provider's (`sign-in.ts`): the application never inspects a token, it
// keeps the access token of the recovery session the provider opens and sends
// it as the bearer of one request, the new password, to the API. Nothing here
// logs, and neither the token nor the bearer is ever put in an address.

// The API's two routes (`apps/api/password-set.ts`): `reset`, the ask, answered 200 `{}` whatever
// the address; `set`, the new password with the recovery session's bearer.
const PASSWORD_API = '/api/password/';

/** Where the API is, and the fetch to reach it and the provider with. */
export interface Route {
  readonly apiOrigin: string;
  readonly fetch: typeof globalThis.fetch;
}

/** One POST of a JSON body to one of the two routes, with no cookie. */
async function toApi(
  route: Route,
  which: 'reset' | 'set',
  body: Readonly<Record<string, string>>,
  extra: Readonly<Record<string, string>> = {},
): Promise<Response> {
  const url = `${route.apiOrigin}${PASSWORD_API}${which}`;
  return await route.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extra },
    credentials: 'omit',
    body: JSON.stringify(body),
  });
}

/** Whether the ask reached the API; what it answered says nothing about the address. */
export async function askReset(route: Route, address: string): Promise<boolean> {
  try {
    return (await toApi(route, 'reset', { address })).ok;
  } catch {
    return false;
  }
}

/** The reset link's token, read from its fragment (`#token_hash=...`), or null when it has none. */
export function recoveryTokenOf(fragment: string): string | null {
  const token = new URLSearchParams(fragment.replace(/^#/u, '')).get('token_hash');
  return token === null || token === '' ? null : token;
}

export type Verified =
  | { readonly ok: true; readonly bearer: string }
  | { readonly ok: false; readonly why: 'invalid' | 'unavailable' };

/**
 * The provider spends the token and opens a recovery session. A refusal
 * (used, expired, unknown) is `invalid`; a provider that did not answer, or
 * answered with a fault, a rate limit or no session, is `unavailable`.
 */
export async function verifyRecovery(
  request: { readonly gotrueUrl: string; readonly fetch: typeof globalThis.fetch },
  token: string,
): Promise<Verified> {
  const url = `${request.gotrueUrl.replace(/\/$/u, '')}/verify`;
  try {
    const answer = await request.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'recovery', token_hash: token }),
    });
    if (answer.status >= 500 || answer.status === 429) return { ok: false, why: 'unavailable' };
    if (!answer.ok) return { ok: false, why: 'invalid' };
    const body: unknown = await answer.json().catch(() => {});
    const bearer = (body as { access_token?: unknown } | undefined)?.access_token;
    return typeof bearer === 'string' && bearer !== ''
      ? { ok: true, bearer }
      : { ok: false, why: 'unavailable' };
  } catch {
    return { ok: false, why: 'unavailable' };
  }
}

export type SetOutcome = 'done' | 'invalid' | 'password' | 'unavailable';

/** The new password, sent with the recovery session's bearer, and what the API named. */
export async function setPassword(
  route: Route,
  bearer: string,
  password: string,
): Promise<SetOutcome> {
  try {
    const answer = await toApi(route, 'set', { password }, { authorization: `Bearer ${bearer}` });
    if (answer.ok) return 'done';
    const body: unknown = await answer.json().catch(() => {});
    const code = (body as { code?: unknown } | undefined)?.code;
    if (code === 'RESET_LINK_INVALID') return 'invalid';
    return code === 'PASSWORD_INVALID' ? 'password' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
