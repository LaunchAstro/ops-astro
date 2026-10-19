// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's worker writes (#2011): `review.capture_claim` and `review.capture_land`,
// the contract the site runner fills in #2013. The caller is whoever holds a
// live lease on the review's task: the agent its pickup delegated, or a person
// working their own pickup (the operator landing pictures from the CLI on
// staging). The lease is locked and its holder, fence, liveness and the
// authority behind it re-checked as a check re-checks them (`lockOwnedLease`),
// then the capture rows are locked: a claim takes a revision's captures once,
// and a land writes one width only under the lease and fence that claimed it.
// The operands are judged first, so a picture over the cap or a malformed
// observation stores nothing. Neither the actor nor the delegation comes from
// the body.

import {
  CAPTURE_WIDTHS,
  DATABASE_STORAGE,
  MOST_STORED_BYTES,
  claimCaptures,
  isUuid,
  lockClaimedCapture,
  writeLandedCapture,
  type CaptureLease,
  type CaptureWidth,
} from '../../../core-records/src/index.ts';
import type { Subject, TenantQuery } from '../../../core-records/src/index.ts';
import { lockOwnedLease, type LeaseCaller } from '../../../core-runtime/src/index.ts';
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
  | { readonly claimant: 'agent'; readonly holderActorId: string; readonly delegationId: string }
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
  const owned = await lockOwnedLease(
    tx,
    { ...caller, leaseId: fields.leaseId, fence } as LeaseCaller,
    FIXES,
  );
  if (!owned.ok) return { refusal: owned.refusal as CommandRefusal };
  const { taskId } = owned.value;
  return { lease: { taskId, leaseId: fields.leaseId.toLowerCase(), fence } };
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
  const claimed = await claimCaptures(tx, revisionId, held.lease);
  if ('code' in claimed) return refused(REFUSALS[claimed.code]);
  return applied(revisionId, null, { revisionId, widths: claimed.widths });
}

interface LandFields extends LeaseFields {
  readonly width: unknown;
  readonly picture: unknown;
  readonly observation: unknown;
}

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
    ...(isObservation(observation) &&
    Buffer.byteLength(JSON.stringify(observation)) <= MOST_OBSERVATION_BYTES
      ? []
      : ['observation']),
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
