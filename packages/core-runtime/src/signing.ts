// SPDX-License-Identifier: AGPL-3.0-only
//
// Canonical digests, the decision signature and the chain link.
//
// **Canonical, because a digest over `JSON.stringify` is a digest over key
// order.** Two payloads that mean the same thing would hash differently, and a
// gate bound to one of them would refuse the other for no reason a caller
// could act on. `canonicalise` sorts object keys at every depth and leaves
// arrays alone, since an array's order is part of what it says.
//
// **The signing key is an identity, not a constant.** `signingKey` carries an
// id that goes into the row, so a verifier meeting an unknown key fails rather
// than skipping the check. Tests use an isolated key created in the test; this
// module holds no default and no production key, and there is no vendor or
// custody choice made here — HMAC over the exact stored bytes is the interface
// the transaction contract names, and replacing it with a real signer is a
// change behind `sign`/`verify` rather than a change to every caller.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface SigningKey {
  readonly id: string;
  readonly secret: string;
}

export type Canonical = string;

/** Sorted at every depth, so a digest is over meaning rather than over key order. */
export function canonicalise(value: unknown): Canonical {
  return JSON.stringify(order(value));
}

function order(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => order(item));
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).toSorted()) sorted[key] = order(source[key]);
  return sorted;
}

export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonicalise(value), 'utf8').digest('hex');
}

export function sign(key: SigningKey, digest: string): string {
  return createHmac('sha256', key.secret).update(`${key.id}:${digest}`, 'utf8').digest('hex');
}

/**
 * Constant time, because a verifier that returns early on the first wrong byte
 * tells a caller how much of a forged signature was right.
 */
export function verify(key: SigningKey, digest: string, signature: string): boolean {
  const expected = Buffer.from(sign(key, digest), 'hex');
  const presented = Buffer.from(signature, 'hex');
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(expected, presented);
}

/** The genesis link. A chain has to start somewhere, and it starts at a stated value. */
export const CHAIN_GENESIS: string = '0'.repeat(64);

/**
 * The link. It covers the previous hash and every field the row asserts, so
 * removing a row leaves the next row's `prev_hash` pointing at nothing the
 * chain contains.
 */
export function chainHash(previous: string, fields: Record<string, unknown>): string {
  return digestOf({ prev: previous, ...fields });
}

/**
 * Walk a chain and say where it first breaks. Returns `null` when it holds.
 * A verifier that returns a boolean makes "it is broken" and "it is broken at
 * row 4" the same answer, and only one of them is actionable.
 */
export function verifyChain(
  key: SigningKey,
  rows: readonly {
    readonly seq: bigint | number;
    readonly prev_hash: string;
    readonly hash: string;
    /**
     * The persisted payload itself, not the digest the row asserts about it.
     * Required (R9): a verifier given only the digest checks that a number
     * matches a number, and altered content paired with its old digest,
     * signature and hash passes every one of those checks.
     */
    readonly payload: Record<string, unknown>;
    readonly payload_digest: string;
    readonly signature: string;
    readonly signing_key_id: string;
  }[],
  linkFields: (row: (typeof rows)[number]) => Record<string, unknown>,
): string | null {
  let previous = CHAIN_GENESIS;
  for (const row of rows) {
    if (row.signing_key_id !== key.id)
      return `seq ${row.seq}: unknown signing key ${row.signing_key_id}`;
    // R9. Recomputed from the bytes on disk, before the signature is checked:
    // the signature covers the digest, so a digest nobody recomputed makes the
    // signature a statement about a value rather than about the content.
    if (digestOf(row.payload) !== row.payload_digest)
      return `seq ${row.seq}: payload does not match its stored digest`;
    if (!verify(key, row.payload_digest, row.signature))
      return `seq ${row.seq}: signature does not verify`;
    if (row.prev_hash !== previous) return `seq ${row.seq}: prev_hash does not follow the chain`;
    if (chainHash(previous, linkFields(row)) !== row.hash)
      return `seq ${row.seq}: hash does not cover the row`;
    previous = row.hash;
  }
  return null;
}
