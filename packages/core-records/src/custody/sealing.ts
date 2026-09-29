// SPDX-License-Identifier: AGPL-3.0-only
//
// Sealing a secret to the broker (C31; ADR 0028).
//
// The application seals and never opens. It holds the broker's public key and
// nothing else: X25519 against a fresh ephemeral key per value, HKDF-SHA256 to
// an AES-256-GCM key, the tag appended to the ciphertext. The private half is
// the broker's (AW-01), so a process that can write a secret cannot read one
// back, and a leaked application environment leaks no stored value.
//
// The public key comes from `CUSTODY_PUBLIC_KEY` and `CUSTODY_KEY_ID`, or the
// ignored `.local/custody.env` beside the other local files. With neither,
// there is no key to seal to and `secret.set` refuses rather than storing a
// value in the clear.

import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { readEnvFile } from '../env-file.ts';

export interface SealingKey {
  readonly keyId: string;
  readonly publicKey: KeyObject;
}

export interface Sealed {
  readonly sealed: Buffer;
  readonly ephemeralPublic: Buffer;
  readonly nonce: Buffer;
  readonly keyId: string;
}

const INFO = Buffer.from('ops-astro custody v1');
const KEY_ID_SHAPE = /^[A-Za-z0-9._-]{1,64}$/u;

/** The raw 32-byte X25519 public key, as the environment carries it (base64url). */
function importPublic(raw: string): KeyObject {
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.length !== 32) throw new Error('custody: the public key is not 32 bytes');
  return createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: bytes.toString('base64url') },
    format: 'jwk',
  });
}

function wrappingKey(shared: Buffer, ephemeralPublic: Buffer, keyId: string): Buffer {
  const salt = Buffer.concat([ephemeralPublic, Buffer.from(keyId)]);
  return Buffer.from(hkdfSync('sha256', shared, salt, INFO, 32));
}

function rawPublic(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' });
  return Buffer.from(String(jwk.x), 'base64url');
}

/**
 * The broker's public key from the environment or `file`, or undefined when
 * none is configured. A key present but malformed throws: a typo in the key
 * is a fault to look at, not the same as custody switched off.
 */
export function loadSealingKey(
  environment: Readonly<Record<string, string | undefined>>,
  file?: string,
): SealingKey | undefined {
  const fromFile = file === undefined ? {} : readEnvFile(file);
  const keyId = environment['CUSTODY_KEY_ID'] ?? fromFile['CUSTODY_KEY_ID'];
  const raw = environment['CUSTODY_PUBLIC_KEY'] ?? fromFile['CUSTODY_PUBLIC_KEY'];
  if (keyId === undefined && raw === undefined) return undefined;
  if (keyId === undefined || raw === undefined || !KEY_ID_SHAPE.test(keyId)) {
    throw new Error(
      'custody: CUSTODY_KEY_ID and CUSTODY_PUBLIC_KEY must both be set and well formed',
    );
  }
  return { keyId, publicKey: importPublic(raw) };
}

/** Seal `value` to `key`. The value leaves this function only as ciphertext. */
export function seal(value: string, key: SealingKey): Sealed {
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralPublic = rawPublic(ephemeral.publicKey);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: key.publicKey });
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    wrappingKey(shared, ephemeralPublic, key.keyId),
    nonce,
  );
  cipher.setAAD(Buffer.from(key.keyId));
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { sealed: body, ephemeralPublic, nonce, keyId: key.keyId };
}

/**
 * Open a sealed value with the broker's private key. The application never
 * calls this: it is here so the broker (AW-01) and the custody conformance
 * proof share one formula with `seal`, and two copies cannot drift apart.
 */
export function open(sealed: Sealed, privateKey: KeyObject): string {
  const publicKey = importPublic(sealed.ephemeralPublic.toString('base64url'));
  const shared = diffieHellman({ privateKey, publicKey });
  const tagAt = sealed.sealed.length - 16;
  const decipher = createDecipheriv(
    'aes-256-gcm',
    wrappingKey(shared, sealed.ephemeralPublic, sealed.keyId),
    sealed.nonce,
  );
  decipher.setAAD(Buffer.from(sealed.keyId));
  decipher.setAuthTag(sealed.sealed.subarray(tagAt));
  return Buffer.concat([
    decipher.update(sealed.sealed.subarray(0, tagAt)),
    decipher.final(),
  ]).toString('utf8');
}

/** A fresh broker key pair: the public half for the application, the private for the broker. */
export function generateSealingPair(keyId: string): {
  readonly key: SealingKey;
  readonly publicRaw: string;
  readonly privateKey: KeyObject;
} {
  const pair = generateKeyPairSync('x25519');
  return {
    key: { keyId, publicKey: pair.publicKey },
    publicRaw: rawPublic(pair.publicKey).toString('base64url'),
    privateKey: pair.privateKey,
  };
}
