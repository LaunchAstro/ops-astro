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
// (`alg: none`), signed with the wrong secret, missing a `sub`, or simply
// absent: all of them return nothing, and the boundary turns nothing into one
// `AUTH_UNKNOWN_LOGIN`. Distinguishing them tells an unauthenticated caller
// which of their guesses was closer. The one exception is a bearer whose
// signature verifies against this secret and whose `exp` has passed: it
// returns `'expired'`, which the boundary answers `AUTH_SESSION_EXPIRED` (see
// `Verified` and `signatureVerifies`).
//
// **It verifies; it does not decode.** `hono/jwt` checks the HS256 signature
// and `exp` against the secret the local GoTrue was started with. There is no
// path through this file that reads a claim out of an unverified token, which
// is the failure mode a hand-rolled base64 split invites.

import type { Context } from 'hono';
import { verify } from 'hono/jwt';
import type { VerifiedSubject } from '../../../packages/core-records/src/identity/login-resolution.ts';

/** The provider string the `logins` rows carry for tokens verified here. */
export const SUPABASE_PROVIDER = 'supabase';

export interface SupabaseVerifierOptions {
  /** The HS256 secret the local GoTrue signs with, from `.local/auth.env`. */
  readonly secret: string;
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

export type Verifier = (request: Context['req']) => Promise<Verified | undefined>;

/**
 * Build the verifier the API is constructed with.
 *
 * It is a factory taking the secret rather than a module reading the
 * environment, for the reason the draft's boundary gives about its own
 * authentication seam: what an operator can set, an operator can set by
 * accident. The composition root supplies the secret once.
 */
export function createSupabaseVerifier(options: SupabaseVerifierOptions): Verifier {
  const { secret } = options;
  if (secret === '') throw new Error('createSupabaseVerifier: the JWT secret is empty');

  return async function verifySupabaseToken(
    request: Context['req'],
  ): Promise<Verified | undefined> {
    const token = bearerOf(request.header('authorization'));
    if (token === undefined) return undefined;

    let claims: Record<string, unknown>;
    try {
      // HS256 named explicitly: passing the algorithm rather than reading it
      // from the token's own header is what stops a token that nominates
      // `none` from verifying against no key at all. `exp` is checked here.
      claims = (await verify(token, secret, 'HS256')) as Record<string, unknown>;
    } catch (cause) {
      // The algorithm is still named when verifying rather than read from the
      // token's own header, so a token nominating `alg: none` verifies against
      // no key at all and lands here like any other forgery. Only a signature
      // that did verify can be reported as expired.
      return isExpiry(cause) && (await signatureVerifies(token, secret)) ? 'expired' : undefined;
    }

    const subject = claims['sub'];
    if (typeof subject !== 'string' || subject === '') return undefined;

    // Only `sub` crosses. The token's `email`, `role`, `app_metadata` and
    // `user_metadata` are the provider's business and carry no authority here:
    // membership and role are the database's answer, read inside the serving
    // transaction, not a claim a token can assert.
    return { provider: SUPABASE_PROVIDER, subject };
  };
}

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
 * 4.10.7 checks `exp` before the signature (`utils/jwt/jwt.js:63-65` against
 * `:92-101`), so a forged or unsigned bearer with a past `exp` throws
 * `JwtTokenExpired` too. It is verified again with the expiry check off and
 * everything else the first call checked still on: HS256 named, `nbf` and
 * `iat` checked. Only a bearer that passes is `AUTH_SESSION_EXPIRED`; the
 * rest are `AUTH_UNKNOWN_LOGIN` (API.md admission step 1).
 */
async function signatureVerifies(token: string, secret: string): Promise<boolean> {
  try {
    await verify(token, secret, { alg: 'HS256', exp: false });
    return true;
  } catch {
    return false;
  }
}

/** `Authorization: Bearer <token>`, and nothing else counts as one. */
function bearerOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(?<token>[^\s]+)$/iu.exec(header.trim());
  const token = match?.groups?.['token'];
  return token === undefined || token === '' ? undefined : token;
}
