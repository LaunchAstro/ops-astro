// SPDX-License-Identifier: AGPL-3.0-only
//
// Password reset on the login provider's one-time recovery session. Three
// routes outside the business prefix, with no person grant and no cookie
// read or set. The password goes only from the person's browser to the
// provider; nothing here sees one. Answers carry a code and nothing else,
// and nothing is logged.
//
// - `POST /api/password/reset` `{ email }` asks for a link. It is 202 `{}`
//   for every body, every address known or unknown, inside its limits or
//   over them, and the same statement runs for each
//   (`requestPasswordReset`). The caller is the first `x-forwarded-for`
//   address, Vercel's own, kept only as its digest; none is the empty one.
// - `POST /api/password/begin`, with the recovery session's bearer
//   (`recoveryBearer`, below), opens the reset's window before the
//   browser's write (`beginPasswordReset`):
//   200 `{}`, the same for a repeat on the session; 401 `RESET_LINK_INVALID`
//   for any other bearer, a session no minted link opened, a login mapped
//   nowhere, or a window already settled; 403 `RESET_NEEDS_SUPPORT` for a
//   login with a verified authenticator.
// - `POST /api/password/changed`, with the same bearer, after the browser's
//   write. The session's open window, or 401 `RESET_LINK_INVALID`. Then the
//   provider is asked `GET /user` on the same bearer, from its own origin,
//   following no redirect: unless it names the login and shows it updated
//   after the window opened, 409 `RESET_NOT_CONFIRMED`, and the window is
//   left to its bound. Otherwise the window settles and the reset is audited
//   once (`settlePasswordReset`): 200 `{}`.
//
// 503 `RESET_UNAVAILABLE` when the provider's keys cannot be reached to check
// the bearer, `RESET_FAULT` for anything else failing.

import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  beginPasswordReset,
  openWindowOf,
  requestPasswordReset,
  settlePasswordReset,
  type BeginCode,
} from '../../packages/core-commands/src/index.ts';
import {
  SIGN_IN_CLOCK_SKEW_SECONDS,
  type Database,
} from '../../packages/core-records/src/index.ts';
import { readBounded } from './auth/factors.ts';
import { bearerOf } from './auth/session.ts';
import { createTokenCheck, sessionIdOf, type SupabaseVerifierOptions } from './auth/supabase.ts';

export const RESET_REQUEST_PATH = '/api/password/reset';
export const RESET_BEGIN_PATH = '/api/password/begin';
export const RESET_CHANGED_PATH = '/api/password/changed';

/** An address and room for its JSON, no more. */
const REQUEST_MAX_BYTES = 1024;
/** `begin` and `changed` read no body. */
const EMPTY_MAX_BYTES = 64;
const PROVIDER_TIMEOUT_MS = 5000;
/** GoTrue's user carries the login's metadata, the person's own; as `factors.ts` reads it. */
const USER_MAX_BYTES = 1024 * 1024;

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
    if (typeof subject !== 'string' || subject === '') return undefined;
    if (sessionId === undefined || signedInAt === undefined) return undefined;
    const age = now() - signedInAt;
    if (age > RECOVERY_SESSION_SECONDS || age < -SIGN_IN_CLOCK_SKEW_SECONDS) return undefined;
    return { token, subject, sessionId, signedInAt };
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

/**
 * Whether the provider shows the login written after `openedAt`: `GET /user`
 * on the recovery session's own bearer, from the provider's own origin, no
 * redirect followed, bounded in time and size. Any other answer is no.
 */
async function writtenSince(
  options: PasswordResetOptions,
  bearer: RecoveryBearer,
  openedAt: Date,
): Promise<boolean> {
  const base = new URL(options.signIn.issuer);
  const url = new URL(`${base.pathname.replace(/\/+$/u, '')}/user`, base);
  if (url.origin !== base.origin) return false;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${bearer.token}`,
        accept: 'application/json',
        ...(options.providerKey === undefined || options.providerKey === ''
          ? {}
          : { apikey: options.providerKey }),
      },
    });
  } catch {
    return false;
  }
  if (
    response.status !== 200 ||
    !URL.canParse(response.url) ||
    new URL(response.url).origin !== base.origin
  ) {
    await response.body?.cancel();
    return false;
  }
  const read = await readBounded(response, USER_MAX_BYTES, PROVIDER_TIMEOUT_MS);
  if ('fault' in read) return false;
  try {
    const user: unknown = JSON.parse(read.text);
    if (typeof user !== 'object' || user === null) return false;
    const { id, updated_at: updatedAt } = user as Record<string, unknown>;
    if (id !== bearer.subject || typeof updatedAt !== 'string') return false;
    const updated = Date.parse(updatedAt);
    return Number.isFinite(updated) && updated > openedAt.getTime();
  } catch {
    return false;
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
async function begin(context: Context, database: Database, verify: RecoveryVerifier) {
  const bearer = await sessionOf(context, verify);
  if (bearer instanceof Response) return bearer;
  const begun = await beginPasswordReset(database, bearer);
  if (begun.ok) return context.json({}, 200);
  return context.json({ code: begun.code }, BEGIN_STATUS[begun.code]);
}

/** `changed`: the session's open window settled once the provider shows the write. */
async function changed(
  context: Context,
  database: Database,
  verify: RecoveryVerifier,
  options: PasswordResetOptions,
) {
  const bearer = await sessionOf(context, verify);
  if (bearer instanceof Response) return bearer;
  const openedAt = await openWindowOf(database, bearer);
  if (openedAt === undefined) return context.json({ code: 'RESET_LINK_INVALID' }, 401);
  if (!(await writtenSince(options, bearer, openedAt))) {
    return context.json({ code: 'RESET_NOT_CONFIRMED' }, 409);
  }
  await settlePasswordReset(database, bearer);
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

  server.post(RESET_REQUEST_PATH, request, async (context) => {
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
    RESET_BEGIN_PATH,
    empty,
    async (context) => await begin(context, database, verify).catch(() => fault(context)),
  );
  server.post(
    RESET_CHANGED_PATH,
    empty,
    async (context) =>
      await changed(context, database, verify, options).catch(() => fault(context)),
  );
}
