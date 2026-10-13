// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's plan sign-in stores credentials only for a validated ID token
// (#1620): signed with the issuer's published key, for this issuer, this
// client, unexpired, and carrying the nonce the sign-in sent; a later
// sign-in must name the same account. Anything else stores nothing.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { signIn } from '../../apps/model-agent/chatgpt-sign-in.ts';
import { fake, identity } from './plan-fakes.ts';

/** An unsigned (`alg: none`) ID token for `claims`. */
const unsignedToken = (claims: Record<string, unknown>): string =>
  [{ alg: 'none' }, claims, null]
    .map((part) => (part === null ? '' : Buffer.from(JSON.stringify(part)).toString('base64url')))
    .join('.');

it('sign-in stores nothing for an unsigned ID token with another nonce', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'sol-plan-identity-'));
  const issuer = await fake();
  const tokenFile = join(folder, 'tokens.json');
  issuer.answer = () => ({
    status: 200,
    type: 'application/json',
    body: JSON.stringify({
      access_token: 'access-unverified-xxxxxxxx',
      refresh_token: 'refresh-unverified-xxxxxxxx',
      expires_in: 3600,
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      id_token: unsignedToken({ sub: 'other-account', nonce: 'wrong' }),
    }),
  });
  try {
    const result = await signIn({
      issuer: issuer.origin,
      tokenFile,
      port: 0,
      timeoutMs: 5_000,
      say: () => {},
      open: (address) => {
        const asked = new URL(address);
        const callback = new URL(asked.searchParams.get('redirect_uri') ?? '');
        callback.searchParams.set('code', 'sol_fake_code');
        callback.searchParams.set('state', asked.searchParams.get('state') ?? '');
        callback.searchParams.set('client_id', 'oaiapp_sol_fake');
        void fetch(callback).catch(() => {});
      },
    });
    expect(issuer.heard).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(existsSync(tokenFile)).toBe(false);
  } finally {
    await issuer.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

/** A sign-in whose issuer answers with an ID token made from `claims` and `signer`. */
async function signedInWith(
  folder: string,
  claims: (nonce: string, origin: string) => Record<string, unknown>,
  signer: 'published' | 'unpublished' = 'published',
) {
  const issuer = await fake();
  const keys = identity(issuer.origin);
  let nonce = '';
  issuer.answer = (heard) =>
    keys.serve(heard) ?? {
      status: 200,
      type: 'application/json',
      body: JSON.stringify({
        access_token: 'access-validated-xxxxxxxx',
        refresh_token: 'refresh-validated-xxxxxxxx',
        expires_in: 3600,
        scope: 'openid offline_access resource.invoke chatgpt.tokens.use.direct',
        id_token: keys.idToken(claims(nonce, issuer.origin), signer),
      }),
    };
  try {
    return await signIn({
      issuer: issuer.origin,
      tokenFile: join(folder, 'tokens.json'),
      port: 0,
      timeoutMs: 5_000,
      say: () => {},
      open: (address) => {
        const asked = new URL(address);
        nonce = asked.searchParams.get('nonce') ?? '';
        const callback = new URL(asked.searchParams.get('redirect_uri') ?? '');
        callback.searchParams.set('code', 'fake_code');
        callback.searchParams.set('state', asked.searchParams.get('state') ?? '');
        callback.searchParams.set('client_id', 'oaiapp_fake');
        void fetch(callback).catch(() => {});
      },
    });
  } finally {
    await issuer.close();
  }
}

const valid =
  (sub = 'owner-account', overrides: Record<string, unknown> = {}) =>
  (nonce: string, origin: string) => ({
    iss: origin,
    aud: 'oaiapp_fake',
    sub,
    nonce,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  });

it('control: a validated ID token stores the tokens with the account it names', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'plan-identity-'));
  try {
    expect(await signedInWith(folder, valid())).toEqual({ ok: true });
    const held = JSON.parse(readFileSync(join(folder, 'tokens.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(held['subject']).toBe('owner-account');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

it.each([
  ['signed with a key the issuer did not publish', valid(), 'unpublished' as const],
  [
    'expired',
    valid('owner-account', { exp: Math.floor(Date.now() / 1000) - 60 }),
    'published' as const,
  ],
  ['for another client', valid('owner-account', { aud: 'oaiapp_other' }), 'published' as const],
  [
    'from another issuer',
    valid('owner-account', { iss: 'https://issuer.example.test' }),
    'published' as const,
  ],
])('an ID token %s stores nothing', async (_why, claims, signer) => {
  const folder = mkdtempSync(join(tmpdir(), 'plan-identity-'));
  try {
    expect(await signedInWith(folder, claims, signer)).toEqual({
      ok: false,
      code: 'SIGN_IN_IDENTITY_INVALID',
    });
    expect(existsSync(join(folder, 'tokens.json'))).toBe(false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

it('a later sign-in for another account is refused, and the saved tokens stay', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'plan-identity-'));
  try {
    await signedInWith(folder, valid());
    const before = readFileSync(join(folder, 'tokens.json'), 'utf8');
    expect(await signedInWith(folder, valid('another-account'))).toEqual({
      ok: false,
      code: 'SIGN_IN_ACCOUNT_CHANGED',
    });
    expect(readFileSync(join(folder, 'tokens.json'), 'utf8')).toBe(before);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
