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

/**
 * The keys a verifier knows, by id. A row carries the id it was signed under,
 * so a chain that spans a key change verifies each row with its own key
 * rather than failing every row signed before the change. An id the resolver
 * does not know answers `undefined`, and the verifier fails on it: an unknown
 * key is not a row that skips the check.
 */
export type KeyResolver = (id: string) => SigningKey | undefined;

/** A resolver over a fixed list. Today the list is the one configured key. */
export function keyResolver(keys: readonly SigningKey[]): KeyResolver {
  const byId = new Map(keys.map((key) => [key.id, key] as const));
  return (id) => byId.get(id);
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
 * Which fields a decision's link covers. **The version is part of what is
 * stored, never inferred from which recomputation happens to match**: a
 * verifier that tried v2 and fell back to v1 would accept a v2 row whose new
 * fields were altered, because v1 does not look at them.
 *
 * - **v1** is the link `decide` wrote before 23 September 2026. It covers the
 *   row's identity, place, gate, version, decision, person, payload digest and
 *   signature, and not its round, time, lineage, acting actor, evidence digest
 *   or key id. A change to those on a v1 row is not detectable, and a read
 *   reports the row as v1 so nobody takes it for more than it is. v1 rows are
 *   verified as v1 and never rewritten: the stored row is the evidence.
 * - **v2** covers those fields too, and carries `link: 2` inside the hash.
 *   A decision says which it is in its **signed payload** (`link: 2`; absent
 *   is v1), so turning a v2 row into a v1 one to escape the wider check means
 *   changing the payload, which breaks the digest, which breaks the signature.
 * - **v3** links the same fields as v2, with `link: 3`. What changes is the
 *   payload (`decisionPayload`): it signs the round, time, lineage, acting
 *   actor, id, place in the chain and previous link as well. The link hash is
 *   unkeyed, so on v1 and v2 a writer who recomputes every later link can
 *   still change what only the link covers; on v3 the read compares each of
 *   those columns with the signed payload and the change fails there.
 *
 * `decidedAt` is text in one fixed spelling, `DECIDED_AT_TEXT`, rendered by
 * the database from the stored `timestamptz` on both sides: a JavaScript
 * `Date` holds milliseconds and the column holds microseconds, so a link over
 * a `Date` would not survive its own round trip.
 */
export type LinkVersion = 1 | 2 | 3;

/** The version `decide` writes now. */
export const LINK_VERSION: LinkVersion = 3;

/** The row's own fields, in the names the link uses. */
export interface DecisionLinkFields {
  readonly id: string;
  readonly seq: number;
  readonly gate: string;
  readonly version: string;
  readonly decision: string;
  readonly person: string;
  readonly payloadDigest: string;
  readonly signature: string;
  readonly round: number;
  readonly decidedAt: string;
  readonly lineage: string;
  readonly actor: string;
  readonly evidence: string;
  readonly key: string;
}

/** What the link hashes for a row at `version`. */
export function decisionLink(
  version: LinkVersion,
  fields: DecisionLinkFields,
): Record<string, unknown> {
  const v1 = {
    id: fields.id,
    seq: fields.seq,
    gate: fields.gate,
    version: fields.version,
    decision: fields.decision,
    person: fields.person,
    payloadDigest: fields.payloadDigest,
    signature: fields.signature,
  };
  if (version === 1) return v1;
  return {
    ...v1,
    link: version,
    round: fields.round,
    decidedAt: fields.decidedAt,
    lineage: fields.lineage,
    actor: fields.actor,
    evidence: fields.evidence,
    key: fields.key,
  };
}

/**
 * The link version a stored payload declares, or `undefined` for one this
 * code does not know (which fails the read rather than guessing).
 */
export function linkVersionOf(payload: Record<string, unknown>): LinkVersion | undefined {
  if (!('link' in payload)) return 1;
  const link = payload['link'];
  return link === 2 || link === 3 ? link : undefined;
}

/** What `decide` signs for a new decision: every field the read shows or links. */
export interface DecisionPayloadFields {
  readonly id: string;
  readonly seq: number;
  readonly prev: string;
  readonly gate: string;
  readonly version: string;
  readonly lineage: string;
  readonly round: number;
  readonly decision: string;
  readonly by: string;
  readonly actor: string;
  readonly decidedAt: string;
  readonly note: string;
  readonly evidence: string;
  readonly key: string;
}

/**
 * The v3 signed payload. **Pinned**: the version is `link: 3` inside it, and
 * its bytes are `canonicalise` of exactly these keys (sorted at every depth,
 * `JSON.stringify` spelling), which `digestOf` hashes and `sign` signs. A key
 * added, dropped or renamed here is a new version, never a change to v3: a v3
 * row already stored is verified against these keys forever.
 *
 * `prev` and `seq` put the chain-link context inside the signature, so a row
 * moved along the chain, or a chain with a row removed under it, no longer
 * matches what was signed even after every unkeyed link is recomputed.
 * `key` repeats the signing key id the HMAC input already carries, so the
 * shown column is bound to the payload the same way as every other.
 */
export function decisionPayload(fields: DecisionPayloadFields): Record<string, unknown> {
  return {
    link: 3,
    id: fields.id,
    seq: fields.seq,
    prev: fields.prev,
    gate: fields.gate,
    version: fields.version,
    lineage: fields.lineage,
    round: fields.round,
    decision: fields.decision,
    by: fields.by,
    actor: fields.actor,
    decidedAt: fields.decidedAt,
    note: fields.note,
    evidence: fields.evidence,
    key: fields.key,
  };
}

/**
 * The one spelling of `decided_at` a link covers, as SQL over a `timestamptz`
 * expression: UTC, microseconds, a trailing `Z`. Written and read by the
 * database so both sides render the same stored value the same way.
 */
export function decidedAtText(expression: string): string {
  return `to_char(${expression} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** The columns of a stored row that `verifyChain` checks. */
export interface ChainRow {
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
}

/**
 * Walk a chain and say where it first breaks. Returns `null` when it holds.
 * A verifier that returns a boolean makes "it is broken" and "it is broken at
 * row 4" the same answer, and only one of them is actionable.
 *
 * `keys` resolves each row's `signing_key_id` to the key it was signed under,
 * so a chain that spans a key change verifies; an id it does not know is the
 * break. `linkFields` gives what the row's own link version covers, and is
 * handed the caller's own row type, so it reads the columns the link needs
 * without a cast.
 */
export function verifyChain<R extends ChainRow>(
  keys: KeyResolver | SigningKey,
  rows: readonly R[],
  linkFields: (row: R) => Record<string, unknown>,
): string | null {
  // A single key is a resolver with one entry, which is what every caller had
  // before rows could be signed under more than one.
  const resolve = typeof keys === 'function' ? keys : keyResolver([keys]);
  let previous = CHAIN_GENESIS;
  for (const row of rows) {
    const key = resolve(row.signing_key_id);
    if (key === undefined) return `seq ${row.seq}: unknown signing key ${row.signing_key_id}`;
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
