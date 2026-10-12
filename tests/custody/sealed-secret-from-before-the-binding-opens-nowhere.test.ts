// SPDX-License-Identifier: AGPL-3.0-only
import {
  createCipheriv,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { expect, it } from 'vitest';
import { generateSealingPair, open } from '../../packages/core-records/src/custody/sealing.ts';
import type { Sealed, SealedAt } from '../../packages/core-records/src/custody/sealing.ts';

it('a pre-upgrade sealed secret opens neither at home nor in another business', () => {
  const pair = generateSealingPair('x1372/legacy');
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralPublic = Buffer.from(
    String(ephemeral.publicKey.export({ format: 'jwk' }).x),
    'base64url',
  );
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: pair.key.publicKey });
  const salt = Buffer.concat([ephemeralPublic, Buffer.from(pair.key.keyId)]);
  const key = Buffer.from(hkdfSync('sha256', shared, salt, 'ops-astro custody v1', 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(pair.key.keyId));
  const value = 'x1372-synthetic-legacy-value';
  const sealed: Sealed = {
    sealed: Buffer.concat([cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]),
    ephemeralPublic,
    nonce,
    keyId: pair.key.keyId,
  };
  const home: SealedAt = {
    businessId: randomUUID(),
    name: 'provider.key',
    scope: { kind: 'business', id: null },
  };
  // It names no place, so no open can tell home from elsewhere: it is set again.
  expect(() => open(sealed, pair.privateKey, home)).toThrow(/set it again/u);
  expect(() => open(sealed, pair.privateKey, { ...home, businessId: randomUUID() })).toThrow();
});
