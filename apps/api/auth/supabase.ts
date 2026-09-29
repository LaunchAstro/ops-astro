// SPDX-License-Identifier: AGPL-3.0-only
//
// The Supabase Auth adapter: a bearer token in, a verified subject out.
//
// This is the whole of step 1 of login resolution — the step the core
// deliberately does not contain — and it is the only place a caller's identity
// enters the slice. Three properties are what make it that.
//
// **The token is the only input**, as a bearer or as the browser's session
// cookie the bearer was traded for (`session.ts`). Not the body, not a host
// header, not a forwarded header, not a query parameter. A request that
// carries `actorId`, `businessId`, `X-Forwarded-For` or an `apikey` alongside
// its token is a request with those fields nowhere to go (checklist N7). The
// signature is what this function reads and the signature is all it reads.
//
// **A bad token and a missing token are the same answer.** Forged, unsigned
// (`alg: none`), signed with an unpublished key, for another audience or issuer,
// missing a `sub`, or absent: all of them return nothing, and the boundary turns nothing into one
// `AUTH_UNKNOWN_LOGIN`. Distinguishing them tells an unauthenticated caller
// which of their guesses was closer. The one exception is a bearer whose
// signature verifies against a published key and whose `exp` has passed: it
// returns `'expired'`, which the boundary answers `AUTH_SESSION_EXPIRED` (see
// `Verified` and `jwks.ts`).
//
// **It verifies; it does not decode.** `jwks.ts` checks the ES256 signature,
// `exp`, audience and issuer against the provider's published keys. There is no
// path through this file that reads a claim out of an unverified token, which
// is the failure mode a hand-rolled base64 split invites.

import type { Context } from 'hono';
import type { VerifiedSubject } from '../../../packages/core-records/src/index.ts';
import { createKeySetVerifier, type KeySetFetch, type KeySetRefusal } from './jwks.ts';
import { bearerOf, sessionCookieOf } from './session.ts';

/** The provider string the `logins` rows carry for tokens verified here. */
export const SUPABASE_PROVIDER = 'supabase';

/** The `aud` GoTrue gives a signed-in session (`GOTRUE_JWT_AUD`). */
export const SUPABASE_AUDIENCE = 'authenticated';

export interface SupabaseVerifierOptions {
  /** The `iss` GoTrue stamps on its tokens: its own URL, `GOTRUE_URL`. */
  readonly issuer: string;
  /** The provider's published key set, `…/.well-known/jwks.json`. */
  readonly keySetUrl: string;
  readonly fetch?: KeySetFetch;
  /** Told each refused answer from the provider, by reason only. */
  readonly onRefusal?: (refusal: KeySetRefusal) => void;
}

/**
 * What the boundary learns about a caller: a verified subject, the one word
 * `'expired'`, or nothing.
 *
 * **Why `expired` is told apart and the rest are not.** API.md's rule stands
 * for every other failure: a missing, forged, unsigned or subject-less token
 * all answer the same, because telling them apart tells an unauthenticated
 * caller which guess was closer. An expired token is not a guess. Its
 * signature verifies against a key the provider published, so whoever sent it held
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
 * It is a factory taking the key set's address rather than a module reading
 * the environment, because what an operator can set, an operator can set by
 * accident. The composition root supplies it once.
 */
export function createSupabaseVerifier(options: SupabaseVerifierOptions): Verifier {
  const verifyToken = createKeySetVerifier({
    keySetUrl: options.keySetUrl,
    issuer: options.issuer,
    audience: SUPABASE_AUDIENCE,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.onRefusal === undefined ? {} : { onRefusal: options.onRefusal }),
  });

  return async function verifySupabaseToken(
    request: Context['req'],
  ): Promise<Verified | undefined> {
    // The bearer when there is one (the command line), else the browser's
    // session cookie; the door has already held a cookie to the CSRF check.
    const token = bearerOf(request) ?? sessionCookieOf(request);
    if (token === undefined) return undefined;

    // ES256 pinned, the key chosen by `kid` from the published set, and only
    // a signature that verified can be reported as expired (`jwks.ts`).
    const verdict = await verifyToken(token);
    if (verdict.outcome === 'expired') return 'expired';
    if (verdict.outcome === 'refused') return undefined;

    const subject = verdict.claims['sub'];
    if (typeof subject !== 'string' || subject === '') return undefined;

    // Only `sub` crosses. The token's `email`, `role`, `app_metadata` and
    // `user_metadata` are the provider's business and carry no authority here:
    // membership and role are the database's answer, read inside the serving
    // transaction, not a claim a token can assert.
    return { provider: SUPABASE_PROVIDER, subject };
  };
}
