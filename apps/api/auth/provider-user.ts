// SPDX-License-Identifier: AGPL-3.0-only
//
// The login provider's `/user`, on a person's own bearer: read it, or write
// the password on a recovery session. Never the admin key. The password
// reset's `begin` and `changed` and the door's session probe ask it.
//
// One fixed destination, the provider's own origin under its issuer; no
// redirect followed; a time limit; a size limit read off the stream. Anything
// else is `unreachable`, never a partial answer, and nothing is logged.

import { readBounded } from './factors.ts';

const PROVIDER_TIMEOUT_MS = 5000;
/** GoTrue's user carries the login's metadata, the person's own; as `factors.ts` reads it. */
const USER_MAX_BYTES = 1024 * 1024;

export interface ProviderUserOptions {
  /** The provider's issuer, `GOTRUE_URL`: the only origin asked. */
  readonly issuer: string;
  /** The hosted provider's publishable key, sent as `apikey`: public; absent, none. */
  readonly providerKey?: string;
  /** Injected for tests; the platform's `fetch` otherwise. */
  readonly fetch?: typeof fetch;
}

type Json = Readonly<Record<string, unknown>>;

/**
 * The provider's answer: its status, and its JSON object, the user on a 200
 * and GoTrue's error (`error_code`) otherwise; an answer that is not one is
 * `{}`.
 */
export type UserAnswer = { readonly status: number; readonly body: Json } | 'unreachable';

/** `GET /user`, or `PUT /user` with `body`, on `token`; see the file's head for the limits. */
export async function askUser(
  options: ProviderUserOptions,
  token: string,
  body?: { readonly password: string },
): Promise<UserAnswer> {
  const base = new URL(options.issuer);
  const url = new URL(`${base.pathname.replace(/\/+$/u, '')}/user`, base);
  if (url.origin !== base.origin) return 'unreachable';
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: body === undefined ? 'GET' : 'PUT',
      redirect: 'error',
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.providerKey === undefined || options.providerKey === ''
          ? {}
          : { apikey: options.providerKey }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return 'unreachable';
  }
  if (!URL.canParse(response.url) || new URL(response.url).origin !== base.origin) {
    await response.body?.cancel();
    return 'unreachable';
  }
  const read = await readBounded(response, USER_MAX_BYTES, PROVIDER_TIMEOUT_MS);
  if ('fault' in read) return 'unreachable';
  return { status: response.status, body: objectOf(read.text) };
}

function objectOf(text: string): Json {
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Json) : {};
  } catch {
    return {};
  }
}

/**
 * Whether the provider still holds `token`'s session for `subject`: `live` on
 * a 200 naming it, `gone` on GoTrue's 403 `session_not_found` (signed out, or
 * deleted by a password write), and `unknown` for anything else, a gateway's
 * refusal included, so no misread answer ends a session for good.
 */
export async function sessionLive(
  options: ProviderUserOptions,
  token: string,
  subject: string,
): Promise<'live' | 'gone' | 'unknown'> {
  const answer = await askUser(options, token);
  if (answer === 'unreachable') return 'unknown';
  if (answer.status === 403 && answer.body['error_code'] === 'session_not_found') return 'gone';
  return answer.status === 200 && answer.body['id'] === subject ? 'live' : 'unknown';
}
