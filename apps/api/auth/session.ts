// SPDX-License-Identifier: AGPL-3.0-only
//
// The browser's session: a cookie the API sets, and the check every request
// carrying it passes (S0-6c, TR-SEC3-3).
//
// The browser posts its token once as a bearer; the API verifies it and hands
// it back as a `Secure`, `HttpOnly`, `SameSite=Lax` cookie no script reads.
// The command line keeps its bearer. A cookie is ambient, so a request it signs
// in must carry `CSRF_HEADER` (another origin cannot add it without a preflight
// this API never answers), must not be marked cross-site, and must name the
// cookie's own person, since one cookie serves every tab.

import type { Context } from 'hono';
import {
  CSRF_HEADER,
  PREFIX,
  SESSION_COOKIE,
  SUBJECT_HEADER,
} from '../../../packages/core-wire/src/index.ts';

/** The cookie as the API sets it: the person prefix only, never script-readable. */
export const SESSION_COOKIE_OPTIONS: {
  readonly path: string;
  readonly httpOnly: true;
  readonly secure: true;
  readonly sameSite: 'Lax';
} = {
  path: PREFIX.person,
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
} as const;

/** `Authorization: Bearer <token>`, and nothing else counts as one. */
export function bearerOf(request: Context['req']): string | undefined {
  const match = /^Bearer\s+(?<token>\S+)$/iu.exec(request.header('authorization')?.trim() ?? '');
  return match?.groups?.['token'];
}

/** The session cookie's value, when the request carries one. */
export function sessionCookieOf(request: Context['req']): string | undefined {
  for (const pair of (request.header('cookie') ?? '').split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    const value = rest.join('=');
    if (name === SESSION_COOKIE && value !== '') return value;
  }
  return undefined;
}

/**
 * Whether the request came from this application's own pages: `CSRF_HEADER`
 * present, and no `Sec-Fetch-Site` naming another site. Current browsers send
 * `Sec-Fetch-Site`; the header alone holds for one that does not.
 */
export function fromOwnPages(request: Context['req']): boolean {
  const site = request.header('sec-fetch-site');
  return request.header(CSRF_HEADER) === '1' && (site === undefined || site === 'same-origin');
}

/**
 * Whether this request's credential is the cookie and it fails the check.
 * A bearer is the credential when there is one, as the verifier reads it.
 */
export function crossSiteSession(request: Context['req']): boolean {
  return (
    bearerOf(request) === undefined &&
    sessionCookieOf(request) !== undefined &&
    !fromOwnPages(request)
  );
}

/**
 * Whether the credential is the cookie and it is not the person this tab
 * signed in as. Another tab in the same browser may have signed someone else
 * in since, and the cookie is theirs now.
 */
export function otherPersonsCookie(request: Context['req'], subject: string): boolean {
  return bearerOf(request) === undefined && request.header(SUBJECT_HEADER) !== subject;
}

/** The fix the door sends with `AUTH_SESSION_MISMATCH`. */
export const MISMATCH_FIXES: readonly string[] = [
  'Someone else has signed in in this browser since. Sign out and sign in again.',
];

/** The fix the door sends with `AUTH_CROSS_SITE`. */
export const CROSS_SITE_FIXES: readonly string[] = [
  'Send the request from this application’s own pages, which add the header it needs.',
];
