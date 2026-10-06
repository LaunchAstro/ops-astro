// SPDX-License-Identifier: AGPL-3.0-only
//
// `POST /api/password/set` (C40, link use, ORCH77-C40B): the reset page sends
// the link's one-time token and the new password, and the password is set
// (`setPasswordByToken`). Outside the business prefix, with no person grant
// and no session: the token is the authority. No cookie is read or set and
// no credential is answered, so the reset opens no session of any kind.
//
// Answers carry a code and nothing else, and nothing is logged: 200
// `{ passwordSet: true }`; 401 `RESET_LINK_INVALID` for every token that is
// not live (unknown, spent, expired, of a login no business maps); 403
// `RESET_NEEDS_SUPPORT` for a login with a verified second factor, nothing
// spent (ORCH77-C40MFA); 400 `PASSWORD_INVALID` for a password out of bounds,
// `RESET_MALFORMED` for a body that is not one; 413 `RESET_TOO_LARGE`; 422
// `RESET_PASSWORD_REFUSED` when the provider refused the password itself
// (choose another, with a new link); 503 `RESET_UNAVAILABLE` when the provider
// failed or answered wrongly, or where the login stands could not be read; 503
// `RESET_FAULT` otherwise. Once the token is spent, a failure has still ended
// the person's sessions and audited nothing.
//
// Mounted by the composition root only when it is given the deployment's
// businesses and the broker; `main()` does not turn it on yet (C40-plan).

import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  setPasswordByToken,
  type PasswordReset,
  type PasswordResetCode,
} from '../../packages/core-commands/src/index.ts';
import type { Broker } from '../../packages/core-custody/src/index.ts';
import type { BusinessId, Database } from '../../packages/core-records/src/index.ts';

export const PASSWORD_SET_PATH = '/api/password/set';

/** A token, a password and room for their JSON, no more. */
const SET_MAX_BYTES = 1024;

export interface PasswordSetOptions {
  /** The deployment's businesses, the ones the token is looked for in. */
  readonly businesses: () => Promise<readonly BusinessId[]>;
  /** The broker whose custody holds the login provider's service key. */
  readonly broker: Broker;
}

const STATUS: Readonly<Record<PasswordResetCode, 400 | 401 | 403 | 422 | 503>> = {
  RESET_LINK_INVALID: 401,
  RESET_NEEDS_SUPPORT: 403,
  PASSWORD_INVALID: 400,
  RESET_PASSWORD_REFUSED: 422,
  RESET_UNAVAILABLE: 503,
};

/** The body, when it is one JSON object holding the token and password as strings. */
async function resetOf(request: Request): Promise<PasswordReset | undefined> {
  try {
    const body: unknown = await request.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
    const { token, password } = body as Record<string, unknown>;
    if (typeof token !== 'string' || typeof password !== 'string') return undefined;
    return { token, password };
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
      const reset = await resetOf(context.req.raw);
      if (reset === undefined) return context.json({ code: 'RESET_MALFORMED' }, 400);
      const result = await setPasswordByToken(database, await options.businesses(), options, reset);
      if (result.ok) return context.json({ passwordSet: true }, 200);
      return context.json({ code: result.code }, STATUS[result.code]);
    } catch {
      return context.json({ code: 'RESET_FAULT' }, 503);
    }
  });
}
