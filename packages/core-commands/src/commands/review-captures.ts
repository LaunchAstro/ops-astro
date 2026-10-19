// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's worker writes (#2011): `review.capture_claim` and `review.capture_land`,
// the contract the site runner fills in #2013. The caller is whoever holds a
// live lease on the review's task: the agent its pickup delegated, or a person
// working their own pickup (the operator landing pictures from the CLI on
// staging). The lease is locked and its holder, fence, liveness and the
// authority behind it re-checked as a check re-checks them (`lockOwnedLease`),
// then the capture rows are locked and all of it judged again at the instant
// read after that wait, so a lease or a grant that lapsed while the call waited
// writes nothing. A claim takes a revision's captures once, and a land writes
// one width only under the lease and fence that claimed it.
// The operands are judged first, so a picture over the cap or a malformed
// observation stores nothing. Neither the actor nor the delegation comes from
// the body.

import {
  CAPTURE_WIDTHS,
  DATABASE_STORAGE,
  MOST_STORED_BYTES,
  checkDelegatedAuthority,
  claimLockedCaptures,
  isUuid,
  lockClaimedCapture,
  lockRevisionCaptures,
  writeLandedCapture,
  type CaptureLease,
  type CaptureWidth,
} from '../../../core-records/src/index.ts';
import type { Delegation, Subject, TenantQuery } from '../../../core-records/src/index.ts';
import {
  lockOwnedLease,
  lockedInstant,
  recheckOwner,
  type LeaseCaller,
} from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { personClaimant } from './tasks-claimant.ts';

/** The observation's cap once serialised, so a land fits the API's body limit with its picture. */
const MOST_OBSERVATION_BYTES = 192 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

const FIXES = {
  notOwned:
    'Claim and land a capture under the live lease your pickup handed back, with its fence.',
  lost: 'A capture is landed under current rights. Ask a manager for write on this task.',
  expired: 'A capture is claimed and landed only while the lease is live. Pick the work up again.',
};

const REFUSALS = {
  NOT_FOUND: refuseCommand('NOT_FOUND', [], ['Name a revision of a review on your lease’s task.']),
  CAPTURE_NOT_CLAIMABLE: refuseCommand(
    'CAPTURE_NOT_CLAIMABLE',
    ['revisionId'],
    ['Another live lease holds this capture, or it has landed.'],
  ),
  CAPTURE_NOT_CLAIMED: refuseCommand(
    'CAPTURE_NOT_CLAIMED',
    ['leaseId'],
    ['Land a capture only under the lease and fence that claimed it.'],
  ),
  OBJECT_TOO_LARGE: refuseCommand(
    'PICTURE_TOO_LARGE',
    ['picture'],
    [`A picture is at most ${MOST_STORED_BYTES} bytes.`],
  ),
} as const;

/** Who holds the lease: the session's person, or the agent and the delegation it presented. */
export type CaptureCaller =
  | { readonly claimant: 'agent'; readonly holderActorId: string; readonly delegation: Delegation }
  | {
      readonly claimant: 'person';
      readonly holderActorId: string;
      readonly subjects: readonly Subject[];
      readonly collection: string;
    };

export const personCaller = (context: CommandContext): CaptureCaller => {
  const person = personClaimant(context);
  return {
    claimant: 'person',
    holderActorId: person.actorId,
    subjects: person.subjects,
    collection: person.collection,
  };
};

interface LeaseFields {
  readonly leaseId: unknown;
  readonly fence: unknown;
  readonly revisionId: unknown;
}

const invalidLease = (fields: LeaseFields): string[] => [
  ...(typeof fields.fence === 'number' && Number.isSafeInteger(fields.fence) ? [] : ['fence']),
  ...(isUuid(fields.revisionId) ? [] : ['revisionId']),
];

const leaseCallerOf = (caller: CaptureCaller, leaseId: string, fence: number): LeaseCaller =>
  caller.claimant === 'agent'
    ? {
        claimant: 'agent',
        holderActorId: caller.holderActorId,
        delegationId: caller.delegation.id,
        leaseId,
        fence,
      }
    : { ...caller, leaseId, fence };

/** The lease held and re-checked, or the refusal; a malformed id is a lease not owned. */
async function holdLease(
  tx: TenantQuery,
  fields: LeaseFields,
  caller: CaptureCaller,
): Promise<{ readonly lease: CaptureLease } | { readonly refusal: CommandRefusal }> {
  if (!isUuid(fields.leaseId)) {
    return { refusal: refuseCommand('LEASE_NOT_OWNED', [], [FIXES.notOwned]) };
  }
  const fence = fields.fence as number;
  const owned = await lockOwnedLease(tx, leaseCallerOf(caller, fields.leaseId, fence), FIXES);
  if (!owned.ok) return { refusal: owned.refusal as CommandRefusal };
  const { taskId } = owned.value;
  return { lease: { taskId, leaseId: fields.leaseId.toLowerCase(), fence } };
}

/**
 * After the capture rows' lock wait, at a fresh instant: the lease is still the caller's, live
 * and current, a person's own write on the task still stands, and an agent's delegating person
 * still holds the write its call was checked for (`checkDelegatedAuthority` judges grants as
 * its statement runs). The refusal, or `null` when the write may go ahead.
 */
async function stillHeld(
  tx: TenantQuery,
  lease: CaptureLease,
  caller: CaptureCaller,
): Promise<CommandRefusal | null> {
  const at = await lockedInstant(tx);
  const owner = await recheckOwner(
    tx,
    leaseCallerOf(caller, lease.leaseId, lease.fence),
    at,
    FIXES,
  );
  if (!owner.ok) return owner.refusal as CommandRefusal;
  if (caller.claimant === 'person') return null;
  const reach = await checkDelegatedAuthority(tx, caller.delegation, {
    collection: 'task',
    action: 'write',
    scope: { kind: 'record', id: lease.taskId },
  });
  return reach.ok ? null : reach.refusal;
}

const fieldsRefused = (wrong: readonly string[], fix: string): HandlerOutcome =>
  refused(refuseCommand('FIELD_VALUE_INVALID', wrong, [fix]));

export async function claimCapture(
  tx: TenantQuery,
  fields: LeaseFields,
  caller: CaptureCaller,
): Promise<HandlerOutcome> {
  const wrong = invalidLease(fields);
  if (wrong.length > 0) {
    return fieldsRefused(wrong, 'Send the fence the pickup handed back and the revision.');
  }
  const held = await holdLease(tx, fields, caller);
  if ('refusal' in held) return refused(held.refusal);
  const revisionId = String(fields.revisionId).toLowerCase();
  const locked = await lockRevisionCaptures(tx, revisionId, held.lease);
  if ('code' in locked) return refused(REFUSALS[locked.code]);
  const lapsed = await stillHeld(tx, held.lease, caller);
  if (lapsed !== null) return refused(lapsed);
  const claimed = await claimLockedCaptures(tx, locked.ids, held.lease);
  if ('code' in claimed) return refused(REFUSALS[claimed.code]);
  return applied(revisionId, null, { revisionId, widths: claimed.widths });
}

interface LandFields extends LeaseFields {
  readonly width: unknown;
  readonly picture: unknown;
  readonly observation: unknown;
}

/**
 * What Postgres refuses to keep in jsonb, as serialised JSON escapes it: a NUL character (22P05)
 * and half a surrogate pair (22P02). `JSON.stringify` writes a whole pair as itself, never escaped.
 */
const UNSTORABLE_ESCAPE = /(?<!\\)(?:\\\\)*\\u(?:0000|d[89a-f][0-9a-f]{2})/u;

const isObservation = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const seen = value as Readonly<Record<string, unknown>>;
  const sheets = seen['stylesheets'];
  return (
    ['url', 'documentDigest', 'text', 'html'].every((key) => typeof seen[key] === 'string') &&
    Number.isSafeInteger(seen['status']) &&
    typeof sheets === 'object' &&
    sheets !== null &&
    !Array.isArray(sheets) &&
    Object.values(sheets).every((digest) => typeof digest === 'string')
  );
};

const storable = (observation: Readonly<Record<string, unknown>>): boolean => {
  const serialised = JSON.stringify(observation);
  return (
    Buffer.byteLength(serialised) <= MOST_OBSERVATION_BYTES && !UNSTORABLE_ESCAPE.test(serialised)
  );
};

const LAND_FIX = `Send the width (${CAPTURE_WIDTHS.join(' or ')}), the picture as base64 and the page observation as the fenced capture made it, at most ${MOST_OBSERVATION_BYTES} bytes.`;

export async function landCapture(
  tx: TenantQuery,
  fields: LandFields,
  caller: CaptureCaller,
): Promise<HandlerOutcome> {
  const { picture, observation } = fields;
  const width = CAPTURE_WIDTHS.find((known) => known === fields.width);
  const wrong = [
    ...invalidLease(fields),
    ...(width === undefined ? ['width'] : []),
    ...(typeof picture === 'string' && picture !== '' && BASE64.test(picture) ? [] : ['picture']),
    ...(isObservation(observation) && storable(observation) ? [] : ['observation']),
  ];
  if (wrong.length > 0 || width === undefined || !isObservation(observation)) {
    return fieldsRefused(wrong, LAND_FIX);
  }
  const body = Buffer.from(String(picture), 'base64');
  if (body.byteLength > MOST_STORED_BYTES) return refused(REFUSALS.OBJECT_TOO_LARGE);
  const held = await holdLease(tx, fields, caller);
  if ('refusal' in held) return refused(held.refusal);
  const revisionId = String(fields.revisionId).toLowerCase();
  const at = { revisionId, width: width satisfies CaptureWidth };
  const capture = await lockClaimedCapture(tx, at, held.lease);
  if ('code' in capture) return refused(REFUSALS[capture.code]);
  const lapsed = await stillHeld(tx, held.lease, caller);
  if (lapsed !== null) return refused(lapsed);
  const stored = await DATABASE_STORAGE.put(tx, body);
  if ('refused' in stored) return refused(REFUSALS.OBJECT_TOO_LARGE);
  await writeLandedCapture(tx, capture.captureId, {
    observation,
    pictureId: stored.id,
    pictureDigest: stored.digest,
  });
  return applied(capture.captureId, null, {
    revisionId,
    width,
    pictureId: stored.id,
    pictureDigest: stored.digest,
  });
}

/** The person entries: their own pickup's lease. */
export const claimCaptureAsPerson = async (
  tx: TenantQuery,
  context: CommandContext,
  request: LeaseFields,
): Promise<HandlerOutcome> => await claimCapture(tx, request, personCaller(context));

export const landCaptureAsPerson = async (
  tx: TenantQuery,
  context: CommandContext,
  request: LandFields,
): Promise<HandlerOutcome> => await landCapture(tx, request, personCaller(context));
