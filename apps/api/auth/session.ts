// SPDX-License-Identifier: AGPL-3.0-only
//
// The browser's session: a cookie the API sets, and the check every request
// carrying it passes (S0-6c, TR-SEC3-3).
//
// The browser trades its token once for a `Secure`, `HttpOnly`, `SameSite=Lax`
// cookie, one per sign-in, named from an id only that tab is given, so a tab
// reads only its own session and a late sign-out ends only the one it names. A
// cookie is ambient: a request it signs in must carry `CSRF_HEADER` (no other
// origin can without a preflight this API never answers).

import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import {
  CSRF_HEADER,
  PREFIX,
  SESSION_COOKIE,
  SESSION_HEADER,
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

/** One sign-in's id: a digest of its token, not a credential, the same on a retry. */
export const sessionIdOf = (token: string): string =>
  createHash('sha256').update(token).digest('hex').slice(0, 32);

/** The cookie that holds one sign-in's session. */
export const cookieNameFor = (id: string): string => `${SESSION_COOKIE}-${id}`;

/** The session id a request names, when it is one this API could have issued. */
export function namedSession(request: Context['req']): string | undefined {
  const id = request.header(SESSION_HEADER);
  return id !== undefined && /^[0-9a-f]{32}$/u.test(id) ? id : undefined;
}

/** Every session cookie the request carries, by name. */
function sessionCookies(request: Context['req']): Map<string, string> {
  const found = new Map<string, string>();
  for (const pair of (request.header('cookie') ?? '').split(';')) {
    const [name = '', ...rest] = pair.trim().split('=');
    const value = rest.join('=');
    if (name.startsWith(SESSION_COOKIE) && value !== '') found.set(name, value);
  }
  return found;
}

/** The session cookie of the sign-in the tab names, when there is one. */
export function sessionCookieOf(request: Context['req']): string | undefined {
  const id = namedSession(request);
  return id === undefined ? undefined : sessionCookies(request).get(cookieNameFor(id));
}

/** `CSRF_HEADER` present, and no `Sec-Fetch-Site` naming another site. */
export function fromOwnPages(request: Context['req']): boolean {
  const site = request.header('sec-fetch-site');
  return request.header(CSRF_HEADER) === '1' && (site === undefined || site === 'same-origin');
}

/** The credential is a cookie (no bearer) and the request fails the check. */
export function crossSiteSession(request: Context['req']): boolean {
  return (
    bearerOf(request) === undefined && sessionCookies(request).size > 0 && !fromOwnPages(request)
  );
}

/** Session cookies present, and neither a bearer nor a session the tab names. */
export function unnamedSession(request: Context['req']): boolean {
  return (
    bearerOf(request) === undefined &&
    namedSession(request) === undefined &&
    sessionCookies(request).size > 0
  );
}

/** The fix the door sends with `AUTH_SESSION_MISMATCH`. */
export const MISMATCH_FIXES: readonly string[] = [
  'This tab names no session of its own. Sign in again.',
];

/** The fix the door sends with `AUTH_CROSS_SITE`. */
export const CROSS_SITE_FIXES: readonly string[] = [
  'Send the request from this application’s own pages, which add the header it needs.',
];
