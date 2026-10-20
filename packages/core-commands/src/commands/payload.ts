// SPDX-License-Identifier: AGPL-3.0-only
//
// The register's view of a request (`envelope.ts`): what two attempts under
// one operation id are compared on, and the digest that compares them.

import { timingSafeEqual } from 'node:crypto';
import { canonicalPayload, payloadDigest } from '../../../core-digest/src/index.ts';
import type { CredentialKeysDecision } from '../../../core-records/src/index.ts';
import type { UncheckedRequest } from './requests.ts';

/** A body that carries a secret (C31): no refusal or digest puts its value where it can be read back. */
export const SEALED_BODIES: ReadonlySet<string> = new Set(['secret.set']);

/**
 * The part of a request the register compares, which is everything except the
 * identity itself. Two requests differing only in their `operation_id` are two
 * attempts, not a conflict; two differing anywhere else under one identity are
 * the conflict `OPERATION_ID_REUSED` names.
 */
export function comparablePayload(request: UncheckedRequest): Readonly<Record<string, unknown>> {
  const { operationId: _identity, ...rest } = request;
  return rest;
}

/** Who a request's digest is bound to: the transaction's business and the caller's actor. */
export interface DigestOwner {
  readonly businessId: string;
  readonly actorId: string;
}

/** A request's digest, and whether a sealed value went unkeyed because no keyring is held. */
export interface Digested {
  readonly digest: string;
  readonly unkeyed: boolean;
}

/** The sealed value's canonical text, or none when the body has no value to protect. */
function sealedValue(request: UncheckedRequest): string | undefined {
  if (!SEALED_BODIES.has(request.command) || !Object.hasOwn(request, 'value')) return undefined;
  return canonicalPayload(request['value'] ?? null);
}

const withValue = (request: UncheckedRequest, value: unknown): string =>
  payloadDigest({ ...comparablePayload(request), value });

/**
 * The digest the register and the audit keep for a request. Every command but
 * a sealed one digests as it always has. A sealed body's value, whatever its
 * JSON kind, is replaced by its MAC under the keyring's active key, bound to
 * the business and the actor, so a reader of the rows cannot check a guess
 * without a key the database does not hold. With no keyring the value is
 * replaced by a mark that holds nothing of it, and the caller refuses.
 */
export function requestDigest(
  owner: DigestOwner,
  request: UncheckedRequest,
  keys: CredentialKeysDecision,
): Digested {
  const value = sealedValue(request);
  if (value === undefined)
    return { digest: payloadDigest(comparablePayload(request)), unkeyed: false };
  if (!keys.ok) return { digest: withValue(request, { unkeyed: true }), unkeyed: true };
  const valueMac = keys.keys.valueMac(owner.businessId, owner.actorId, value);
  return { digest: withValue(request, { valueMac }), unkeyed: false };
}

const same = (one: string, other: string): boolean =>
  one.length === other.length && timingSafeEqual(Buffer.from(one), Buffer.from(other));

/**
 * Whether a stored digest that differs from this request's is still the same
 * sealed request: digested under another key this process still holds, or
 * before sealed values were keyed (the plain digest, recomputed here and
 * never written). Any other command, or no match, is a different request.
 */
export function storedDigestMatches(
  owner: DigestOwner,
  request: UncheckedRequest,
  keys: CredentialKeysDecision,
  stored: string,
): boolean {
  const value = sealedValue(request);
  if (value === undefined) return false;
  const held =
    keys.ok &&
    keys.keys.valueMacMatches(owner.businessId, owner.actorId, value, (valueMac) =>
      same(withValue(request, { valueMac }), stored),
    );
  return held || same(payloadDigest(comparablePayload(request)), stored);
}
