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
// bounds, `RESET_MALFORMED` for a body that is not one; 413 `RESET_TOO_LARGE`;
// 503 `RESET_UNAVAILABLE` when the provider's key set could not be reached (as
// the session exchange answers) or the provider failed or answered wrongly,
// the link then spent and nothing else changed; 503 `RESET_FAULT` otherwise.
//
// Mounted by the composition root only when it is given the deployment's
// businesses and the provider; `main()` does not turn it on yet (C40-plan).

import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  setPasswordByRecovery,
  type PasswordProvider,
} from '../../packages/core-commands/src/index.ts';
import type { BusinessId, Database } from '../../packages/core-records/src/index.ts';
import type { Verifier } from './auth/supabase.ts';
import { bearerOf } from './auth/session.ts';

export const PASSWORD_SET_PATH = '/api/password/set';

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
      if (presented === 'unavailable') return context.json({ code: 'RESET_UNAVAILABLE' }, 503);
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
