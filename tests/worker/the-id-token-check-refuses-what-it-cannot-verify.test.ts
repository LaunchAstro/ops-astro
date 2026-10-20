// SPDX-License-Identifier: AGPL-3.0-only
//
// #1620 P2: the ID token check on its own, for answers a JSON encoder can't
// write: an expiry that is not a finite number of seconds is refused, and a
// key set holding entries that are not keys is refused, never thrown on.

import { sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimsHold, validatedSubject } from '../../apps/model-agent/id-token.ts';
import {
  ISSUED,
  idToken,
  startSignInIssuer,
  type SignInIssuer,
} from '../custody/fixtures/sign-in-world.ts';

const expected = {
  issuer: 'https://auth.openai.com',
  clientId: ISSUED,
  nonce: 'synthetic-nonce',
  now: Date.now(),
};
const part = (text: string): string => Buffer.from(text).toString('base64url');

let issuer: SignInIssuer;
beforeAll(async () => {
  issuer = await startSignInIssuer();
});
afterAll(async () => {
  await issuer.close();
});

describe('the ID token check', () => {
  it('refuses an expiry that is not a finite number of seconds', () => {
    // Written as raw JSON: JSON.stringify would turn 1e400 into null.
    const head = part('{"alg":"RS256","kid":"synthetic-kid"}');
    for (const exp of ['1e400', '"9999999999"', 'null']) {
      const body = part(
        `{"iss":"${expected.issuer}","aud":"${ISSUED}","nonce":"${expected.nonce}","sub":"synthetic-subject-a","exp":${exp}}`,
      );
      const signed = `${head}.${body}`;
      const token = `${signed}.${sign('RSA-SHA256', Buffer.from(signed), issuer.key).toString('base64url')}`;
      expect(claimsHold(token, expected), exp).toBeUndefined();
    }
  });

  it('refuses, never throws on, a key set holding entries that are not keys', () => {
    const claims = {
      iss: expected.issuer,
      aud: ISSUED,
      nonce: expected.nonce,
      sub: 'synthetic-subject-a',
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    const claimed = claimsHold(idToken(claims, issuer.key), expected);
    expect(claimed).toBeDefined();
    if (claimed === undefined) return;
    expect(validatedSubject(claimed, [null, 7, 'synthetic-key', []])).toBeUndefined();
  });
});
