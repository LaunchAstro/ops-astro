// SPDX-License-Identifier: AGPL-3.0-only
//
// The browser's session: a cookie the API sets, and the check every request
// carrying it passes (S0-6c, TR-SEC3-3).
//
// **The token never stays in the page.** The browser signs in at the identity
// provider as before, then posts the token here once as a bearer. The API
// verifies it with the same published keys as any other bearer and hands it
// back as a `Secure`, `HttpOnly`, `SameSite=Lax` cookie, so no script in the
// page, an injected one included, can read it. The command line never comes
// here: it keeps its bearer.
//
// **A cookie is ambient, so it is checked.** The browser attaches it to any
// request to this origin, a forged one from another site included, where a
// bearer only travels when the caller's own code adds it. So a request the
// cookie signs in must carry `CSRF_HEADER` (which another origin cannot add
// without a preflight this API never answers) and must not be one the browser
// itself marks as coming from another site. The exchange and the sign-out are
// held to the same rule, so no other page can sign a person in or out.

import type { Context } from 'hono';
import { CSRF_HEADER, PREFIX, SESSION_COOKIE } from '../../../packages/core-wire/src/index.ts';

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

/** The fix the door sends with `AUTH_CROSS_SITE`. */
export const CROSS_SITE_FIXES: readonly string[] = [
  'Send the request from this application’s own pages, which add the header it needs.',
];
