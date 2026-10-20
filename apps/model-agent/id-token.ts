// SPDX-License-Identifier: AGPL-3.0-only
//
// The ID token a plan sign-in returns, judged before anything is stored
// (#1620 P2), as OpenAI's open-source token-sharing flow requires
// (https://developers.openai.com/siwc/token-sharing-open-source/sign-in):
// an RS256 token naming a key, issued by the issuer signed in at, for the
// issued client id, unexpired, carrying this attempt's nonce and naming an
// account (`sub`), signed by a key in the issuer's published key set.
//
// No network here: the sign-in fetches the key set and hands it in. A token
// that fails any check is undefined, and nothing is written.

import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';

export interface Expected {
  readonly issuer: string;
  readonly clientId: string;
  readonly nonce: string;
  readonly now: number;
}

/** The claims checked with no key: the key id to verify with, and the account. */
export interface Claimed {
  readonly kid: string;
  readonly subject: string;
  readonly signed: Buffer;
  readonly signature: Buffer;
}

const part = (text: string | undefined): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(Buffer.from(text ?? '', 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/** The issuer as the token may name it: the origin, with or without its slash. */
export const sameIssuer = (named: unknown, issuer: string): boolean =>
  named === issuer || named === `${issuer}/`;

/** The token's parts when every claim holds; else undefined. */
export function claimsHold(idToken: unknown, expected: Expected): Claimed | undefined {
  if (typeof idToken !== 'string') return undefined;
  const [head, body, sig, ...rest] = idToken.split('.');
  if (rest.length > 0 || head === undefined || body === undefined || !sig) return undefined;
  const header = part(head);
  const claims = part(body);
  if (header?.['alg'] !== 'RS256' || typeof header['kid'] !== 'string') return undefined;
  if (claims === undefined || !sameIssuer(claims['iss'], expected.issuer)) return undefined;
  const audience = claims['aud'];
  if (!(Array.isArray(audience) ? audience : [audience]).includes(expected.clientId))
    return undefined;
  const expires = claims['exp'];
  if (!Number.isFinite(expires) || (expires as number) * 1000 <= expected.now) return undefined;
  if (claims['nonce'] !== expected.nonce) return undefined;
  const subject = claims['sub'];
  if (typeof subject !== 'string' || subject === '') return undefined;
  return {
    kid: header['kid'],
    subject,
    signed: Buffer.from(`${head}.${body}`),
    signature: Buffer.from(sig, 'base64url'),
  };
}

/** The account a token names when its claims hold and a published RSA key with its id signed it. */
export function validatedSubject(claimed: Claimed, keys: readonly unknown[]): string | undefined {
  const key = keys.find(
    (k): k is JsonWebKey =>
      typeof k === 'object' &&
      k !== null &&
      (k as JsonWebKey)['kid'] === claimed.kid &&
      (k as JsonWebKey).kty === 'RSA',
  );
  if (key === undefined) return undefined;
  try {
    return verify(
      'RSA-SHA256',
      claimed.signed,
      createPublicKey({ key, format: 'jwk' }),
      claimed.signature,
    )
      ? claimed.subject
      : undefined;
  } catch {
    return undefined;
  }
}
