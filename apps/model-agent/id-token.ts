// SPDX-License-Identifier: AGPL-3.0-only
//
// The ID token a plan sign-in returns, validated before anything is stored
// (#1620), as OpenAI's open-source token-sharing flow requires
// (https://developers.openai.com/siwc/token-sharing-open-source/sign-in):
//
//   - its claims first, with no network: an RS256 token naming a key, issued
//     by the issuer signed in at, for the client id being saved, unexpired,
//     carrying the nonce this sign-in sent, and naming an account (`sub`);
//   - then its signature, against the issuer's published key set, found
//     through the issuer's OpenID configuration on the issuer's own origin.
//
// A token that fails either is refused, and nothing is written.

import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';

export interface Expected {
  readonly issuer: string;
  readonly clientId: string;
  readonly nonce: string;
  readonly now: number;
}

interface Parsed {
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
const sameIssuer = (named: unknown, issuer: string): boolean =>
  named === issuer || named === `${issuer}/`;

/** The token's parts when every claim holds, with no network; else undefined. */
export function claimsHold(idToken: string, expected: Expected): Parsed | undefined {
  const [head, body, sig, ...rest] = idToken.split('.');
  if (rest.length > 0 || sig === undefined || sig === '') return undefined;
  const header = part(head);
  const claims = part(body);
  if (header?.['alg'] !== 'RS256' || typeof header['kid'] !== 'string') return undefined;
  if (claims === undefined || !sameIssuer(claims['iss'], expected.issuer)) return undefined;
  const audience = claims['aud'];
  const audiences = Array.isArray(audience) ? audience : [audience];
  if (!audiences.includes(expected.clientId)) return undefined;
  const expires = claims['exp'];
  if (typeof expires !== 'number' || expires * 1000 <= expected.now) return undefined;
  if (claims['nonce'] !== expected.nonce) return undefined;
  const subject = claims['sub'];
  if (typeof subject !== 'string' || subject === '') return undefined;
  return {
    kid: header['kid'],
    subject,
    signed: Buffer.from(`${head ?? ''}.${body ?? ''}`),
    signature: Buffer.from(sig, 'base64url'),
  };
}

/** JSON from a URL on the issuer's own origin, or undefined. */
async function fetched(url: string, issuer: string): Promise<Record<string, unknown> | undefined> {
  if (URL.parse(url)?.origin !== new URL(issuer).origin) return undefined;
  try {
    const answer = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!answer.ok) return undefined;
    const body: unknown = await answer.json();
    return typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The issuer's published key with this id, or undefined. */
async function publishedKey(issuer: string, kid: string): Promise<JsonWebKey | undefined> {
  const configuration = await fetched(`${issuer}/.well-known/openid-configuration`, issuer);
  if (configuration === undefined || !sameIssuer(configuration['issuer'], issuer)) return undefined;
  const uri = configuration['jwks_uri'];
  const set = typeof uri === 'string' ? await fetched(uri, issuer) : undefined;
  const keys = Array.isArray(set?.['keys']) ? (set['keys'] as JsonWebKey[]) : [];
  return keys.find((key) => key['kid'] === kid && key.kty === 'RSA');
}

/** The account the validated ID token names, or undefined when it does not validate. */
export async function validatedSubject(
  idToken: unknown,
  expected: Expected,
): Promise<string | undefined> {
  if (typeof idToken !== 'string') return undefined;
  const parsed = claimsHold(idToken, expected);
  if (parsed === undefined) return undefined;
  const key = await publishedKey(expected.issuer, parsed.kid);
  if (key === undefined) return undefined;
  try {
    const publicKey = createPublicKey({ key, format: 'jwk' });
    return verify('RSA-SHA256', parsed.signed, publicKey, parsed.signature)
      ? parsed.subject
      : undefined;
  } catch {
    return undefined;
  }
}
