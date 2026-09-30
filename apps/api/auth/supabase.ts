// SPDX-License-Identifier: AGPL-3.0-only
//
// The Supabase Auth adapter: a bearer token in, a verified subject out.
//
// This is the whole of step 1 of login resolution — the step the core
// deliberately does not contain — and it is the only place a caller's identity
// enters the slice. Three properties are what make it that.
//
// **The token is the only input.** Not the body, not a host header, not a
// forwarded header, not a query parameter. A request that carries `actorId`,
// `businessId`, `X-Forwarded-For` or an `apikey` alongside its token is a
// request with those fields nowhere to go (checklist N7). The signature is
// what this function reads and the signature is all it reads.
//
// **A bad token and a missing token are the same answer.** Forged, unsigned
// (`alg: none`), signed with the wrong secret, for another audience or issuer,
// missing a `sub`, or absent: all of them return nothing, and the boundary turns nothing into one
// `AUTH_UNKNOWN_LOGIN`. Distinguishing them tells an unauthenticated caller
// which of their guesses was closer. The one exception is a bearer whose
// signature verifies against this secret and whose `exp` has passed, or whose
// session is past its 12-hour absolute limit (C58, `pastAbsoluteLimit`): it
// returns `'expired'`, which the boundary answers `AUTH_SESSION_EXPIRED` (see
// `Verified` and `signatureVerifies`).
//
// **It verifies; it does not decode.** `hono/jwt` checks the HS256 signature,
// `exp`, audience and issuer against the secret GoTrue was started with. There is no
// path through this file that reads a claim out of an unverified token, which
// is the failure mode a hand-rolled base64 split invites.

import type { Context } from 'hono';
import { verify } from 'hono/jwt';
import {
  SESSION_ABSOLUTE_SECONDS,
  type Assurance,
  type VerifiedSubject,
} from '../../../packages/core-records/src/index.ts';

/** The provider string the `logins` rows carry for tokens verified here. */
export const SUPABASE_PROVIDER = 'supabase';

/** The `aud` GoTrue gives a signed-in session (`GOTRUE_JWT_AUD`). */
export const SUPABASE_AUDIENCE = 'authenticated';

export interface SupabaseVerifierOptions {
  /** The HS256 secret the local GoTrue signs with, from `.local/auth.env`. */
  readonly secret: string;
  /** The `iss` GoTrue stamps on its tokens: its own URL, `GOTRUE_URL`. */
  readonly issuer: string;
  /** The time in whole seconds, injected for tests; the clock otherwise. */
  readonly now?: () => number;
}

/**
 * What the boundary learns about a caller: a verified subject, the one word
 * `'expired'`, or nothing.
 *
 * **Why `expired` is told apart and the rest are not.** API.md's rule stands
 * for every other failure: a missing, forged, unsigned or subject-less token
 * all answer the same, because telling them apart tells an unauthenticated
 * caller which guess was closer. An expired token is not a guess. Its
 * signature verifies against this deployment's secret, so whoever sent it held
 * a real credential this server issued a session for, and they learn nothing
 * from being told it has run out that they could not already prove. What they
 * gain is the difference between a door they can open and one they cannot:
 * `AUTH_SESSION_EXPIRED` is the re-login path and the browser already draws it
 * as one.
 */
export type Verified = VerifiedSubject | 'expired';

type Checks = Parameters<typeof verify>[2];

export type Verifier = (request: Context['req']) => Promise<Verified | undefined>;

/**
 * Build the verifier the API is constructed with.
 *
 * It is a factory taking the secret rather than a module reading the
 * environment, because what an operator can set, an operator can set by
 * accident. The composition root supplies the secret once.
 */
export function createSupabaseVerifier(options: SupabaseVerifierOptions): Verifier {
  const { secret, issuer } = options;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  if (secret === '') throw new Error('createSupabaseVerifier: the JWT secret is empty');
  const expected = { alg: 'HS256', aud: SUPABASE_AUDIENCE, iss: issuer } as const;

  return async function verifySupabaseToken(
    request: Context['req'],
  ): Promise<Verified | undefined> {
    const token = bearerOf(request.header('authorization'));
    if (token === undefined) return undefined;

    let claims: Record<string, unknown>;
    try {
      // HS256 named explicitly: passing the algorithm rather than reading it
      // from the token's own header is what stops a token that nominates
      // `none` from verifying against no key at all. `exp`, `aud` and `iss` too.
      claims = (await verify(token, secret, expected)) as Record<string, unknown>;
    } catch (cause) {
      // The algorithm is still named when verifying rather than read from the
      // token's own header, so a token nominating `alg: none` verifies against
      // no key at all and lands here like any other forgery. Only a signature
      // that did verify can be reported as expired.
      const expired =
        isExpiry(cause) && (await signatureVerifies(token, secret, { ...expected, exp: false }));
      return expired ? 'expired' : undefined;
    }

    const subject = claims['sub'];
    if (typeof subject !== 'string' || subject === '') return undefined;

    // `sub` crosses, and beside it how strongly the provider says the caller
    // signed in (C59, LF-4). The token's `email`, `role`, `app_metadata` and
    // `user_metadata` are the provider's business and carry no authority here:
    // membership and role are the database's answer, read inside the serving
    // transaction, not a claim a token can assert.
    const assurance = assuranceOf(claims);
    if (pastAbsoluteLimit(assurance.signedInAt, now())) return 'expired';
    const sessionId = sessionIdOf(claims);
    return sessionId === undefined
      ? { provider: SUPABASE_PROVIDER, subject, assurance }
      : { provider: SUPABASE_PROVIDER, subject, assurance, sessionId };
  };
}

/**
 * The provider's session, `session_id`, which a refresh carries unchanged
 * (C58): how a person's sessions are told apart, listed and ended. Anything
 * but a UUID names no session, so a token cannot aim at a session by a
 * crafted value; a token with none is served as before and simply has no
 * session to list or end here.
 */
function sessionIdOf(claims: Readonly<Record<string, unknown>>): string | undefined {
  const value = claims['session_id'];
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * The assurance a verified token carries: `aal`, and from `amr` the time of the
 * session's first sign-in and of its second factor.
 *
 * **The factor time is the `amr` entry, never `iat`.** GoTrue stamps each
 * method with the time it was performed and copies the list into every token
 * the session refreshes, so a refresh carries the factor time unchanged and
 * never renews it (TR-SEC4-6). `iat` moves on every refresh.
 *
 * **Anything it cannot read is the lowest level.** An unknown `aal`, an `amr`
 * that is not a list, a time that is not a whole number, or `aal2` with no
 * factor entry all read as `aal1` with no factor time, so a malformed claim
 * grants nothing a missing one would not.
 */
function assuranceOf(claims: Readonly<Record<string, unknown>>): Assurance {
  const methods = Array.isArray(claims['amr']) ? (claims['amr'] as readonly unknown[]) : [];
  const times = (wanted: ReadonlySet<string>): number | null => {
    const found = methods
      .map((entry) => (typeof entry === 'object' && entry !== null ? entry : {}))
      .filter((entry) => wanted.has(String((entry as Record<string, unknown>)['method'])))
      .map((entry) => (entry as Record<string, unknown>)['timestamp'])
      .filter((time): time is number => Number.isSafeInteger(time) && (time as number) > 0);
    return found.length === 0 ? null : Math.max(...found);
  };
  const signedInAt = times(FIRST_FACTOR_METHODS);
  const factorAt = times(SECOND_FACTOR_METHODS);
  if (claims['aal'] === 'aal2' && factorAt !== null) {
    return { level: 'aal2', signedInAt, factorAt };
  }
  return { level: 'aal1', signedInAt, factorAt: null };
}

/**
 * The session's absolute limit (C58): 12 hours from the first sign-in, set in
 * `SESSION_ABSOLUTE_SECONDS` and nowhere else, with no idle limit. The first
 * sign-in is the `amr` first-factor time, which a refresh carries unchanged,
 * never `iat`, which every refresh moves. A token with no first-sign-in time,
 * or one more than a minute ahead of this clock, cannot be shown to be inside
 * the limit, so it is past it: the same `AUTH_SESSION_EXPIRED`, whose answer
 * is to sign in again.
 */
function pastAbsoluteLimit(signedInAt: number | null, now: number): boolean {
  if (signedInAt === null) return true;
  const age = now - signedInAt;
  return age > SESSION_ABSOLUTE_SECONDS || age < -60;
}

/** GoTrue's `amr` methods that begin a session: the first factor. */
const FIRST_FACTOR_METHODS: ReadonlySet<string> = new Set([
  'password',
  'otp',
  'magiclink',
  'email/signup',
  'recovery',
  'invite',
  'oauth',
  'sso/saml',
]);

/** The one second factor C59 enrols: the authenticator app. */
const SECOND_FACTOR_METHODS: ReadonlySet<string> = new Set(['totp']);

/**
 * Whether Hono's verifier rejected a token for its `exp` rather than its
 * signature.
 *
 * `hono/jwt` throws a named error for expiry. It is matched by name rather
 * than by class so that a version bump changing the class hierarchy degrades
 * to "not expired" — which is `AUTH_UNKNOWN_LOGIN`, the stricter answer —
 * instead of reporting a forgery as an ended session.
 */
function isExpiry(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'JwtTokenExpired';
}

/**
 * Whether a token Hono called expired is signed by this deployment's secret.
 *
 * **Hono's name for the error is not proof of the signature.** `hono/jwt`
 * 4.13.9 checks `exp`, `iss` and `aud` before the signature (`utils/jwt/jwt.js`
 * `verify`), so a forged or unsigned bearer with a past `exp` throws
 * `JwtTokenExpired` too. It is verified again with the expiry check off and
 * everything else the first call checked still on: HS256 named, `nbf`, `iat`,
 * `aud` and `iss` checked. Only a bearer that passes is `AUTH_SESSION_EXPIRED`; the
 * rest are `AUTH_UNKNOWN_LOGIN` (API.md admission step 1).
 */
async function signatureVerifies(token: string, secret: string, checks: Checks): Promise<boolean> {
  try {
    await verify(token, secret, checks);
    return true;
  } catch {
    return false;
  }
}

/** `Authorization: Bearer <token>`, and nothing else counts as one. */
export function bearerOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(?<token>[^\s]+)$/iu.exec(header.trim());
  const token = match?.groups?.['token'];
  return token === undefined || token === '' ? undefined : token;
}
