// SPDX-License-Identifier: AGPL-3.0-only
//
// The browser's session: a cookie the API sets, and the check every request
// carrying it passes (S0-6c, TR-SEC3-3).
//
// The browser trades its token once for a `Secure`, `HttpOnly`, `SameSite=Lax`
// cookie, one per sign-in, named from an id only that tab is given, so a tab
// reads only its own session and a late sign-out ends only the one it names. A
// tab closed without signing out never names its cookie again, so the door
// clears any other sign-in's cookie whose token has run out (`lapsedSessions`).
// A cookie is ambient: a request it signs in must carry `CSRF_HEADER` (no other
// origin can without a preflight this API never answers).

import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { SESSION_ABSOLUTE_SECONDS } from '../../../packages/core-records/src/index.ts';
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

/**
 * The cookie's `Max-Age` (C58): what is left of the session's 12-hour absolute
 * limit, `SESSION_ABSOLUTE_SECONDS`, from its first sign-in, never more than
 * the whole limit. A session with no first-sign-in time gets none of it.
 */
export function cookieMaxAge(signedInAt: number | null, now: number): number {
  const left = signedInAt === null ? 0 : signedInAt + SESSION_ABSOLUTE_SECONDS - now;
  return Math.min(SESSION_ABSOLUTE_SECONDS, Math.max(0, left));
}

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

/** Every session cookie the request carries, a repeated name each time. */
function sessionCookies(request: Context['req']): (readonly [string, string])[] {
  return (request.header('cookie') ?? '')
    .split(';')
    .map((pair) => pair.trim().split('='))
    .map(([name = '', ...rest]) => [name, rest.join('=')] as const)
    .filter(([name, value]) => name.startsWith(SESSION_COOKIE) && value !== '');
}

/** The named sign-in's cookie, exactly once, holding a token of that id; else none. */
export function sessionCookieOf(request: Context['req']): string | undefined {
  const id = namedSession(request);
  const held = sessionCookies(request).filter(([name]) => name === cookieNameFor(id ?? ''));
  const token = held.length === 1 ? held[0]?.[1] : undefined;
  return token !== undefined && sessionIdOf(token) === id ? token : undefined;
}

/**
 * The cookies of other sign-ins this request carries whose token's `exp` has
 * passed: a closed tab's, which nothing names again, and which would otherwise
 * ride on every request until the headers are too large to answer. The claim
 * is read unverified because all it decides is that the cookie holding it is
 * cleared, and a token past its `exp` is refused whoever sends it.
 */
export function lapsedSessions(request: Context['req'], now: number): string[] {
  const named = cookieNameFor(namedSession(request) ?? '');
  const lapsed = sessionCookies(request).filter(([name, token]) => {
    if (name === named) return false;
    try {
      const payload = Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8');
      const exp: unknown = (JSON.parse(payload) as { exp?: unknown } | null)?.exp;
      return typeof exp === 'number' && exp < now;
    } catch {
      return false;
    }
  });
  return [...new Set(lapsed.map(([name]) => name))];
}

/**
 * Any `Authorization` header or session cookie, good or not: a sign-in
 * attempt. A tab that names its sign-in tries only that sign-in's cookie, so
 * once that cookie is gone (cleared as lapsed, or past its `Max-Age`) the
 * cookies of other tabs beside it are no attempt of its own.
 */
export function presentsCredential(request: Context['req']): boolean {
  if (request.header('authorization') !== undefined) return true;
  const id = namedSession(request);
  const held = sessionCookies(request);
  return id === undefined ? held.length > 0 : held.some(([name]) => name === cookieNameFor(id));
}

/** `CSRF_HEADER` present, and no `Sec-Fetch-Site` naming another site. */
export function fromOwnPages(request: Context['req']): boolean {
  const site = request.header('sec-fetch-site');
  return request.header(CSRF_HEADER) === '1' && (site === undefined || site === 'same-origin');
}

/** The credential is a cookie (no bearer) and the request fails the check. */
export function crossSiteSession(request: Context['req']): boolean {
  return (
    bearerOf(request) === undefined && sessionCookies(request).length > 0 && !fromOwnPages(request)
  );
}

/** Session cookies present, and neither a bearer nor a session the tab names. */
export function unnamedSession(request: Context['req']): boolean {
  return (
    bearerOf(request) === undefined &&
    namedSession(request) === undefined &&
    sessionCookies(request).length > 0
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
