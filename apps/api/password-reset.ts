// SPDX-License-Identifier: AGPL-3.0-only
//
// Password reset on the login provider's one-time recovery session. Three
// routes outside the business prefix, with no person grant and no cookie
// read or set. The new password passes through `changed` on its way to the
// provider, written on the person's own recovery session, never with an admin
// key, and is kept, logged or answered nowhere. Answers carry a code and
// nothing else, and nothing is logged.
//
// - `POST /api/password/reset` `{ email }` asks for a link. It is 202 `{}`
//   for every body, every address known or unknown, inside its limits or
//   over them, and the same statement runs for each
//   (`requestPasswordReset`). The caller is the first `x-forwarded-for`
//   address, Vercel's own, kept only as its digest; none is the empty one.
// - `POST /api/password/begin`, with the recovery session's bearer
//   (`recoveryBearer`, below), opens the reset's window before the write
//   (`beginPasswordReset`). The provider's `GET /user` on the bearer names
//   the login and its latest mailed link's `recovery_sent_at`, which must be
//   the minted link's own: a sign-in link minted since replaces it there.
//   200 `{}`, the same for a repeat on the session; 401 `RESET_LINK_INVALID`
//   for any other bearer, a session no minted link opened, a login mapped
//   nowhere, or a window already settled; 403 `RESET_NEEDS_SUPPORT` for a
//   login with a verified authenticator.
// - `POST /api/password/changed` `{ password }`, with the same bearer. The
//   session's open window, with room before its bound for the write, and the
//   person the login maps, whom the write is audited as, or 401
//   `RESET_LINK_INVALID` and nothing written. Then the password is written: the provider's
//   `PUT /user` on the same bearer, from its own origin, following no
//   redirect. Its 200 naming the login is the one confirmation, so a write of
//   anything else (the login's metadata) confirms nothing. 422
//   `RESET_PASSWORD_REFUSED` when the provider refuses the password itself;
//   409 `RESET_NOT_CONFIRMED` for no password or any other answer, the window
//   left to its bound. Then every session of the login is signed out at the
//   provider on the same bearer (`signOutEverywhere`), the recovery session's
//   own included, so a bearer kept past the page writes nothing after the
//   settle: such a write would delete a later session at the provider that
//   nothing here asks about once the window settles. Not confirmed, 409
//   `RESET_NOT_CONFIRMED` and the window left to its bound. Otherwise the
//   window settles and the reset is audited once (`settlePasswordReset`):
//   200 `{}`.
//
// 503 `RESET_UNAVAILABLE` when the provider's keys or its user cannot be
// reached to check the bearer, `RESET_FAULT` for anything else failing.

import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  beginPasswordReset,
  requestPasswordReset,
  resetWriteTargetOf,
  settlePasswordReset,
  type BeginCode,
} from '../../packages/core-commands/src/index.ts';
import {
  SIGN_IN_CLOCK_SKEW_SECONDS,
  type Database,
} from '../../packages/core-records/src/index.ts';
import { PASSWORD_RESET_PATHS } from '../../packages/core-wire/src/index.ts';
import { askUser, signOutEverywhere } from './auth/provider-user.ts';
import { bearerOf } from './auth/session.ts';
import { createTokenCheck, sessionIdOf, type SupabaseVerifierOptions } from './auth/supabase.ts';

/** An address and room for its JSON, no more. */
const REQUEST_MAX_BYTES = 1024;
/** `begin` reads no body. */
const EMPTY_MAX_BYTES = 64;
/** A password and room for its JSON, no more. */
const PASSWORD_MAX_BYTES = 1024;

export interface PasswordResetOptions {
  /** The provider's issuer and published keys, as the ordinary verifier has them. */
  readonly signIn: Omit<SupabaseVerifierOptions, 'onRefusal'>;
  /** The hosted provider's publishable key, sent as `apikey`: public; absent, none. */
  readonly providerKey?: string;
  /** Injected for tests; the platform's `fetch` otherwise. */
  readonly fetch?: typeof fetch;
}

const BEGIN_STATUS: Readonly<Record<BeginCode, 401 | 403>> = {
  RESET_LINK_INVALID: 401,
  RESET_NEEDS_SUPPORT: 403,
};

/** The provider's one-time recovery session, as `begin` and `changed` take it. */
export interface RecoveryBearer {
  readonly token: string;
  readonly subject: string;
  readonly sessionId: string;
  /** The session's one sign-in, its `otp` stamp, in whole seconds. */
  readonly signedInAt: number;
  /** The token's `exp`: past it, it can write nothing at the provider. */
  readonly expiresAt: number;
}

export type RecoveryVerifier = (
  request: Context['req'],
) => Promise<RecoveryBearer | 'unavailable' | undefined>;

/** How old a recovery session's sign-in may be: it sets a password, then signs out. */
export const RECOVERY_SESSION_SECONDS = 600;

/** The `otp` stamp of a token whose `amr` is exactly one `otp` entry at `aal1`, or none. */
function otpStampOf(claims: Readonly<Record<string, unknown>>): number | undefined {
  const methods = claims['amr'];
  if (claims['aal'] !== 'aal1' || !Array.isArray(methods) || methods.length !== 1) return;
  const [only] = methods as readonly unknown[];
  if (typeof only !== 'object' || only === null) return;
  const { method, timestamp } = only as Record<string, unknown>;
  return method === 'otp' && Number.isSafeInteger(timestamp) ? (timestamp as number) : undefined;
}

/**
 * The reset's own verifier, `recoveryBearer`: the bearer alone, its signature
 * and issuer checked as the ordinary verifier checks them, then only a
 * session a mailed link opened. That is `aal1`, an `amr` of exactly one `otp`
 * entry stamped within the last 10 minutes (and no more than the clock's
 * minute ahead), and a `session_id`. A password sign-in, a session with a
 * second factor, or anything malformed is nothing.
 */
export function createRecoveryVerifier(options: SupabaseVerifierOptions): RecoveryVerifier {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const check = createTokenCheck(options);
  return async function recoveryBearer(
    request: Context['req'],
  ): Promise<RecoveryBearer | 'unavailable' | undefined> {
    const token = bearerOf(request);
    if (token === undefined) return undefined;
    const claims = await check(token);
    if (claims === 'unavailable') return 'unavailable';
    if (typeof claims !== 'object') return undefined;
    const subject = claims['sub'];
    const sessionId = sessionIdOf(claims);
    const signedInAt = otpStampOf(claims);
    const expiresAt = claims['exp'];
    if (typeof subject !== 'string' || subject === '') return undefined;
    if (sessionId === undefined || signedInAt === undefined) return undefined;
    if (!Number.isSafeInteger(expiresAt)) return undefined;
    const age = now() - signedInAt;
    if (age > RECOVERY_SESSION_SECONDS || age < -SIGN_IN_CLOCK_SKEW_SECONDS) return undefined;
    return { token, subject, sessionId, signedInAt, expiresAt: expiresAt as number };
  };
}

/** The address the body holds, or none; a body that is not one asks for none. */
async function addressOf(request: Request): Promise<string> {
  try {
    const body: unknown = await request.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return '';
    const { email } = body as Record<string, unknown>;
    return typeof email === 'string' ? email : '';
  } catch {
    return '';
  }
}

/** The first `x-forwarded-for` address, the one Vercel's edge writes; none is ''. */
const callerOf = (forwarded: string | undefined): string =>
  (forwarded ?? '').split(',', 1)[0]?.trim() ?? '';

/** The password the body holds, or none. */
async function passwordOf(request: Request): Promise<string | undefined> {
  try {
    const body: unknown = await request.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
    const { password } = body as Record<string, unknown>;
    return typeof password === 'string' && password !== '' ? password : undefined;
  } catch {
    return undefined;
  }
}

type Verified = RecoveryBearer | Response;

/** The request's recovery session, or the answer refusing it. */
async function sessionOf(context: Context, verify: RecoveryVerifier): Promise<Verified> {
  const bearer = await verify(context.req);
  if (bearer === 'unavailable') return context.json({ code: 'RESET_UNAVAILABLE' }, 503);
  return bearer ?? context.json({ code: 'RESET_LINK_INVALID' }, 401);
}

const fault = (context: Context): Response => context.json({ code: 'RESET_FAULT' }, 503);

/** `begin`: the session's one window opened, or the refusal. */
async function begin(
  context: Context,
  database: Database,
  verify: RecoveryVerifier,
  options: PasswordResetOptions,
) {
  const bearer = await sessionOf(context, verify);
  if (bearer instanceof Response) return bearer;
  const user = await askUser(providerOf(options), bearer.token);
  if (user === 'unreachable') return context.json({ code: 'RESET_UNAVAILABLE' }, 503);
  const sentAt = user.body['recovery_sent_at'];
  if (user.status !== 200 || user.body['id'] !== bearer.subject || typeof sentAt !== 'string') {
    return context.json({ code: 'RESET_LINK_INVALID' }, 401);
  }
  const begun = await beginPasswordReset(database, { ...bearer, providerSentAt: sentAt });
  if (begun.ok) return context.json({}, 200);
  return context.json({ code: begun.code }, BEGIN_STATUS[begun.code]);
}

const providerOf = (options: PasswordResetOptions) => ({
  issuer: options.signIn.issuer,
  ...(options.providerKey === undefined ? {} : { providerKey: options.providerKey }),
  ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
});

/** `changed`: the password written on the session, the session signed out, then its window settled. */
async function changed(
  context: Context,
  database: Database,
  verify: RecoveryVerifier,
  options: PasswordResetOptions,
) {
  const bearer = await sessionOf(context, verify);
  if (bearer instanceof Response) return bearer;
  const password = await passwordOf(context.req.raw);
  const target = await resetWriteTargetOf(database, bearer);
  if (target === undefined) return context.json({ code: 'RESET_LINK_INVALID' }, 401);
  if (password === undefined) return context.json({ code: 'RESET_NOT_CONFIRMED' }, 409);
  const written = await askUser(providerOf(options), bearer.token, { password });
  if (written !== 'unreachable' && written.status === 422) {
    return context.json({ code: 'RESET_PASSWORD_REFUSED' }, 422);
  }
  if (
    written === 'unreachable' ||
    written.status !== 200 ||
    written.body['id'] !== bearer.subject
  ) {
    return context.json({ code: 'RESET_NOT_CONFIRMED' }, 409);
  }
  if ((await signOutEverywhere(providerOf(options), bearer.token)) !== 'ended') {
    return context.json({ code: 'RESET_NOT_CONFIRMED' }, 409);
  }
  await settlePasswordReset(database, bearer, target);
  return context.json({}, 200);
}

/** Mount the three routes on `server`, the way `composeApi` mounts the hooks. */
export function mountPasswordReset(
  server: Hono,
  database: Database,
  options: PasswordResetOptions,
): void {
  const verify = createRecoveryVerifier({
    ...options.signIn,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  // Too large is answered as every request is.
  const request = bodyLimit({
    maxSize: REQUEST_MAX_BYTES,
    onError: (context) => context.json({}, 202),
  });
  const empty = bodyLimit({
    maxSize: EMPTY_MAX_BYTES,
    onError: (context) => context.json({ code: 'RESET_LINK_INVALID' }, 401),
  });
  const withPassword = bodyLimit({
    maxSize: PASSWORD_MAX_BYTES,
    onError: (context) => context.json({ code: 'RESET_PASSWORD_REFUSED' }, 422),
  });

  server.post(PASSWORD_RESET_PATHS.reset, request, async (context) => {
    try {
      const address = await addressOf(context.req.raw);
      await requestPasswordReset(
        database,
        address,
        callerOf(context.req.header('x-forwarded-for')),
      );
    } catch {
      // The same answer: a fault here says nothing about the address either.
    }
    return context.json({}, 202);
  });
  server.post(
    PASSWORD_RESET_PATHS.begin,
    empty,
    async (context) => await begin(context, database, verify, options).catch(() => fault(context)),
  );
  server.post(
    PASSWORD_RESET_PATHS.changed,
    withPassword,
    async (context) =>
      await changed(context, database, verify, options).catch(() => fault(context)),
  );
}
