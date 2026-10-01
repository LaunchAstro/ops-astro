// SPDX-License-Identifier: AGPL-3.0-only
//
// `POST /api/password/set` (C40, link use): the reset page sends the new
// password with the bearer of the recovery session the reset link opened,
// and the password is set (`setPasswordByRecovery`). Outside the business
// prefix, with no person grant: the recovery session is the authority. The
// bearer only, never a cookie, so there is no ambient credential for another
// site to ride, and a recovery session is never traded for one.
//
// Answers carry a code and nothing else, and nothing is logged: 200
// `{ signedOutAtProvider }`; 401 `RESET_LINK_INVALID` for every session that
// is not a live recovery session of a mapped login (none, forged, expired,
// spent, an ordinary sign-in); 400 `PASSWORD_INVALID` for a password out of
// bounds; 503 `RESET_UNAVAILABLE` when the provider failed or answered
// wrongly, nothing changed here.
//
// Mounted, with the ask below, by the composition root when the login
// provider's Send Email hook is configured (`AUTH_EMAIL_HOOK_SECRET`).

import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  requestPasswordReset,
  setPasswordByRecovery,
  type PasswordProvider,
} from '../../packages/core-commands/src/index.ts';
import type { Broker } from '../../packages/core-custody/src/index.ts';
import type { BusinessId, Database } from '../../packages/core-records/src/index.ts';
import type { Verifier } from './auth/supabase.ts';
import { bearerOf } from './auth/session.ts';

export const PASSWORD_SET_PATH = '/api/password/set';
export const PASSWORD_RESET_PATH = '/api/password/reset';

/** A password and room for its JSON, no more. */
const SET_MAX_BYTES = 1024;

export interface PasswordSetOptions {
  /** The deployment's businesses, the ones the login is looked for in. */
  readonly businesses: () => Promise<readonly BusinessId[]>;
  /** The provider's calls with the person's own token. */
  readonly provider: PasswordProvider;
  readonly verify: Verifier;
}

const STATUS = { RESET_LINK_INVALID: 401, PASSWORD_INVALID: 400, RESET_UNAVAILABLE: 503 } as const;

/** The body's password, when it is one JSON object holding it as a string. */
async function passwordOf(request: Request): Promise<string | undefined> {
  try {
    const body: unknown = await request.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
    const { password } = body as Record<string, unknown>;
    return typeof password === 'string' ? password : undefined;
  } catch {
    return undefined;
  }
}

/** Mount the route on `server`, the way `composeApi` mounts the hooks. */
export function mountPasswordSet(
  server: Hono,
  database: Database,
  options: PasswordSetOptions,
): void {
  const tooLarge = bodyLimit({
    maxSize: SET_MAX_BYTES,
    onError: (context) => context.json({ code: 'RESET_TOO_LARGE' }, 413),
  });
  server.post(PASSWORD_SET_PATH, tooLarge, async (context) => {
    try {
      const accessToken = bearerOf(context.req);
      const presented = accessToken === undefined ? undefined : await options.verify(context.req);
      if (accessToken === undefined || typeof presented !== 'object') {
        return context.json({ code: 'RESET_LINK_INVALID' }, 401);
      }
      const password = await passwordOf(context.req.raw);
      if (password === undefined) return context.json({ code: 'RESET_MALFORMED' }, 400);
      const result = await setPasswordByRecovery(
        database,
        await options.businesses(),
        options.provider,
        { presented, accessToken, password },
      );
      if (result.ok) return context.json({ signedOutAtProvider: result.signedOutAtProvider }, 200);
      return context.json({ code: result.code }, STATUS[result.code]);
    } catch {
      return context.json({ code: 'RESET_FAULT' }, 503);
    }
  });
}

/**
 * `POST /api/password/reset` (C40, the ask): `{ address }`, no sign-in. The
 * address goes to the login provider through custody (`requestPasswordReset`)
 * after the answer is given, so every request, for a known address, an
 * unknown one or none, is answered 200 `{}` at once, and its time says
 * nothing either. A failure is nobody's to hear, and nothing is logged.
 */
export function mountPasswordReset(server: Hono, broker: Broker): void {
  const tooLarge = bodyLimit({
    maxSize: SET_MAX_BYTES,
    onError: (context) => context.json({ code: 'RESET_TOO_LARGE' }, 413),
  });
  server.post(PASSWORD_RESET_PATH, tooLarge, async (context) => {
    let address: unknown;
    try {
      const body: unknown = await context.req.json();
      address =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)['address']
          : undefined;
    } catch {
      address = undefined;
    }
    void requestPasswordReset(broker, address).catch(() => {});
    return context.json({}, 200);
  });
}
