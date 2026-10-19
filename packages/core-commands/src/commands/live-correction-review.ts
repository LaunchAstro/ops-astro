// SPDX-License-Identifier: AGPL-3.0-only
//
// R5's two commands (#1689). `live_correction.record_review` records Astra's
// review of a correction from Astra's saved review: a person under the same
// `gate:decide` as the approval names the version digest the review read, and
// the server checks it against the stored version, so a review of an earlier
// version is refused rather than stored against this one (owner question c, the
// recommended answer). `settings.set_single_operator` turns the mode on only
// while the business has one operator, counted under the mode's row lock, which
// the membership trigger takes before it makes a second.

import {
  GATE_COLLECTION,
  insertReview,
  isUuid,
  lockCoveredCorrection,
  lockSingleOperatorMode,
  operatorCount,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import { isInternalReader } from '../reads/tasks.ts';
import type { CommandContext } from './context.ts';
import type { CommandRequest } from './requests.ts';
import { refuseCommand } from './refusal.ts';
import { applied, isRefused, refused, type HandlerOutcome } from './outcome.ts';
import { DECIDED, NOT_VISIBLE } from './live-correction-decide.ts';
import { endedRefusal, standsAfterWaits, writerStillHolds } from './live-correction-standing.ts';
import { setBusinessSetting } from './settings-write.ts';

type Of<K extends CommandRequest['command']> = CommandRequest & { readonly command: K };

const VERDICTS: ReadonlySet<string> = new Set(['approve', 'changes_requested']);
const REVIEW_LIMIT = 20_000;
const REVIEW_FIXES: readonly string[] = [
  'Send verdict as approve or changes_requested, versionDigest as the digest the review read,',
  "and review as Astra's saved review, 1 to 20,000 characters.",
];
const STALE = refuseCommand(
  'VERSION_STALE',
  ['versionDigest'],
  ['Read the correction again; Astra reviews the version it shows.'],
);
const NOT_SINGLE = refuseCommand(
  'SINGLE_OPERATOR_REFUSED',
  ['value'],
  ['Single-operator mode is on only while the business has one operator.'],
);

/** The review's operands, or the names that are not what the command takes. */
function invalidReview(request: Of<'live_correction.record_review'>): readonly string[] {
  const { verdict, versionDigest, review } = request;
  return [
    ...(typeof verdict === 'string' && VERDICTS.has(verdict) ? [] : ['verdict']),
    ...(typeof versionDigest === 'string' && versionDigest !== '' ? [] : ['versionDigest']),
    ...(typeof review === 'string' && review.length > 0 && review.length <= REVIEW_LIMIT
      ? []
      : ['review']),
  ];
}

export async function recordReview(
  tx: TenantQuery,
  context: CommandContext,
  request: Of<'live_correction.record_review'>,
): Promise<HandlerOutcome> {
  const invalid = invalidReview(request);
  if (invalid.length > 0) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', invalid, REVIEW_FIXES));
  }
  const { session } = context;
  if (!isInternalReader(session.roleKey) || !isUuid(request.correctionId)) {
    return refused(NOT_VISIBLE);
  }
  const gate = { subjects: subjectsOf(session), collection: GATE_COLLECTION, action: 'decide' };
  const correction = await lockCoveredCorrection(tx, request.correctionId, gate);
  if (correction === undefined) return refused(NOT_VISIBLE);
  if (correction.state !== 'requested') return refused(DECIDED);
  if (correction.versionDigest !== request.versionDigest) return refused(STALE);
  const stood = await standsAfterWaits(tx, { covering: gate, partyId: correction.partyId });
  if (stood !== 'stands') return refused(NOT_VISIBLE);
  const id = await insertReview(tx, {
    correctionId: correction.id,
    versionDigest: correction.versionDigest,
    verdict: request.verdict as 'approve' | 'changes_requested',
    review: request.review,
    actorId: session.actorId,
    personId: session.personId,
  });
  return applied(id, null, { reviewId: id, correctionId: correction.id, verdict: request.verdict });
}

export async function setSingleOperator(
  tx: TenantQuery,
  context: CommandContext,
  request: Of<'settings.set_single_operator'>,
): Promise<HandlerOutcome> {
  if (request.value === true) {
    await lockSingleOperatorMode(tx, 'update');
    if ((await operatorCount(tx)) !== 1) return refused(NOT_SINGLE);
  }
  const written = await setBusinessSetting(
    tx,
    context,
    request.command,
    request.value,
    request.expectedRevision,
  );
  if (isRefused(written)) return written;
  const stood = await writerStillHolds(tx, context);
  return stood === 'stands' ? written : refused(endedRefusal(stood, false));
}
