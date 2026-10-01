// SPDX-License-Identifier: AGPL-3.0-only
//
// `POST /api/enrol` (C39-T, piece P3): the enrolment page sends the link's
// one-time token and the password its holder set, and the invitation is
// accepted (`acceptInvitation`). Mounted by `createApi` when it is given the
// businesses and a broker: outside the business prefix, with no sign-in and
// no person grant. The token is the authority, and it travels in the body,
// never in an address a log keeps. No cookie is read, so there is no ambient
// credential for another site to ride and no same-site header is asked.
//
// The answer opens no session and sets no cookie: 200 `{ state }`, `enrolled`
// when a login was made, `sign_in` when the address already holds one. Every
// token that is not live (unknown, spent, expired, revoked, replaced by a
// resend) is one answer, 404 `ENROLMENT_LINK_INVALID`; a password out of
// bounds 400 `PASSWORD_INVALID`; the login provider failing 503
// `ENROLMENT_UNAVAILABLE`, nothing spent. An answer carries a code and
// nothing else, and nothing is logged.
//
// `POST /api/b/enrol` is the same link accepted by someone signed in with the
// login they hold (`acceptSignedIn`): the token in the body, no password, and
// the session resolved as the business routes resolve it (the bearer, or the
// cookie this tab names, held to the own-page check), which is why it sits
// under the person prefix the cookie is sent to. No session answers 401 before
// the token is looked at. 200 `{ state: 'joined' }` when the login is bound;
// a dead link, another or unconfirmed address, or a login this business maps
// already are one answer, 404 `ENROLMENT_LINK_INVALID`; the provider failing
// 503 `ENROLMENT_UNAVAILABLE`. It opens no session and sets no cookie.

import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Context } from 'hono';
import { acceptInvitation, acceptSignedIn } from '../../packages/core-commands/src/index.ts';
import type { Broker } from '../../packages/core-custody/src/index.ts';
import type {
  BusinessId,
  Database,
  VerifiedSubject,
} from '../../packages/core-records/src/index.ts';
import { PREFIX } from '../../packages/core-wire/src/index.ts';
import type { Verifier } from './auth/supabase.ts';
import { crossSiteSession, unnamedSession } from './auth/session.ts';

export const ENROL_API_PATH = '/api/enrol';

/** The signed-in accept: under the person prefix, where the session cookie is sent. */
export const ENROL_SIGNED_IN_PATH: string = `${PREFIX.person}enrol`;

/** A token and a password, and room for their JSON, no more. */
const ENROL_MAX_BYTES = 2048;

export interface EnrolmentOptions {
  /** The deployment's businesses, the ones a token is looked for in. */
  readonly businesses: () => Promise<readonly BusinessId[]>;
  /** The broker the login provider is reached through. */
  readonly broker: Broker;
}

const STATUS = {
  ENROLMENT_LINK_INVALID: 404,
  PASSWORD_INVALID: 400,
  ENROLMENT_UNAVAILABLE: 503,
} as const;

/** The request's JSON, or nothing when it is not JSON. */
async function jsonOf(context: Context): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    return undefined;
  }
}

/** The verified session's login, or the answer the business routes give when there is none. */
async function sessionOf(context: Context, verify: Verifier): Promise<VerifiedSubject | Response> {
  if (crossSiteSession(context.req)) return context.json({ code: 'AUTH_CROSS_SITE' }, 403);
  const presented = await verify(context.req);
  if (presented === 'expired') return context.json({ code: 'AUTH_SESSION_EXPIRED' }, 401);
  // The key set could not be reached: nothing is said of the credential (B7).
  if (presented === 'unavailable') return context.json({ code: 'SERVICE_UNAVAILABLE' }, 503);
  if (presented !== undefined && presented !== 'absent') return presented;
  if (unnamedSession(context.req)) return context.json({ code: 'AUTH_SESSION_MISMATCH' }, 401);
  return context.json({ code: 'AUTH_UNKNOWN_LOGIN' }, 401);
}

/** The body's token and password, when it is one JSON object holding both as strings. */
function readBody(body: unknown): { token: string; password: string } | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const { token, password } = body as Record<string, unknown>;
  return typeof token === 'string' && typeof password === 'string'
    ? { token, password }
    : undefined;
}

/** Mount the routes on `server`, the way `composeApi` mounts the hooks. */
export function mountEnrolment(
  server: Hono,
  database: Database,
  options: EnrolmentOptions,
  verify?: Verifier,
): void {
  const tooLarge = bodyLimit({
    maxSize: ENROL_MAX_BYTES,
    onError: (context) => context.json({ code: 'ENROL_TOO_LARGE' }, 413),
  });
  if (verify !== undefined) {
    server.post(ENROL_SIGNED_IN_PATH, tooLarge, async (context) => {
      try {
        const login = await sessionOf(context, verify);
        if (login instanceof Response) return login;
        const body = (await jsonOf(context)) as Record<string, unknown> | null | undefined;
        const token = typeof body === 'object' && body !== null ? body['token'] : undefined;
        if (typeof token !== 'string') return context.json({ code: 'ENROL_MALFORMED' }, 400);
        const result = await acceptSignedIn(database, await options.businesses(), options.broker, {
          token,
          login,
        });
        if (result.ok) return context.json({ state: result.state }, 200);
        return context.json({ code: result.code }, STATUS[result.code]);
      } catch {
        return context.json({ code: 'ENROL_FAULT' }, 503);
      }
    });
  }
  server.post(ENROL_API_PATH, tooLarge, async (context) => {
    try {
      const asked = readBody(await jsonOf(context));
      if (asked === undefined) return context.json({ code: 'ENROL_MALFORMED' }, 400);
      const result = await acceptInvitation(
        database,
        await options.businesses(),
        options.broker,
        asked,
      );
      if (result.ok) return context.json({ state: result.state }, 200);
      return context.json({ code: result.code }, STATUS[result.code]);
    } catch {
      return context.json({ code: 'ENROL_FAULT' }, 503);
    }
  });
}
