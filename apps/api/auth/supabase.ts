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
// **A bad token and a missing token are the same answer.** Expired, forged,
// unsigned (`alg: none`), signed with the wrong secret, missing a `sub`, or
// simply absent: all of them return nothing, and the boundary turns nothing
// into one `AUTH_UNKNOWN_LOGIN`. Distinguishing them tells an unauthenticated
// caller which of their guesses was closer.
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

export type Verifier = (request: Context['req']) => Promise<VerifiedSubject | undefined>;

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
  ): Promise<VerifiedSubject | undefined> {
    const token = bearerOf(request.header('authorization'));
    if (token === undefined) return undefined;

    let claims: Record<string, unknown>;
    try {
      // HS256 named explicitly: passing the algorithm rather than reading it
      // from the token's own header is what stops a token that nominates
      // `none` from verifying against no key at all. `exp` is checked here.
      claims = (await verify(token, secret, 'HS256')) as Record<string, unknown>;
    } catch {
      return undefined;
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

/** `Authorization: Bearer <token>`, and nothing else counts as one. */
function bearerOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(?<token>[^\s]+)$/iu.exec(header.trim());
  const token = match?.groups?.['token'];
  return token === undefined || token === '' ? undefined : token;
}
