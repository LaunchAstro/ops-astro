// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's approval, `live correction approved`, moved out of `live-corrections.ts`
// for its line cap, with R5's single-operator Launch (#1689). The approval
// refuses a caller outside the staff roles before reading any correction, locks
// the row at its party, reads the configured approver under a share lock on its
// setting, and refuses the requester first (release decision 3.4), except where
// single-operator mode admits it: an approval by the business's one operator,
// with the mode and the operator count read under the mode's row lock, and the
// business's first such approval resting on Astra's review of this exact
// version. A correction the site runner has not pinned names no version to
// decide (#1693), and an approval, the single operator's too, lands only while
// the runner's last check of the page is at most 60 s old, read after every
// lock wait (`writeCorrectionDecision`). Only then is the decision written with
// its single-operator mark, which the table requires on any decision by the
// requester.

import {
  GATE_COLLECTION,
  hasSelfApproved,
  isActiveMember,
  isUuid,
  isVerifiedNow,
  lockConfiguredApprover,
  lockCoveredCorrection,
  lockSingleOperatorMode,
  operatorCount,
  reviewApproves,
  subjectsOf,
  writeCorrectionDecision,
} from '../../../core-records/src/index.ts';
import type { LiveCorrection, TenantQuery } from '../../../core-records/src/index.ts';
import { isInternalReader } from '../reads/tasks.ts';
import type { CommandContext } from './context.ts';
import type { CommandRequest } from './requests.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { decisionRefusal } from './live-correction-decision-checks.ts';

type Of<K extends CommandRequest['command']> = CommandRequest & { readonly command: K };

export const NOT_VISIBLE: CommandRefusal = refuseCommand(
  'NOT_FOUND',
  [],
  ['No live correction by that identity in this business.', 'Name one you can see.'],
);
const UNCONFIGURED = refuseCommand(
  'APPROVER_NOT_CONFIGURED',
  [],
  ['An administrator names the approver with settings.set_live_correction_approver.'],
);
const NOT_THE_APPROVER = refuseCommand(
  'APPROVER_NOT_CONFIGURED_ONE',
  [],
  ['Only the configured staff approver approves a live correction.'],
);
const SELF = refuseCommand(
  'SELF_APPROVAL_REFUSED',
  [],
  [
    'A second person approves the change; ask the configured approver.',
    'In single-operator mode, the one operator approves their own change.',
  ],
);
const REVIEW_MISSING = refuseCommand(
  'ASTRA_REVIEW_MISSING',
  ['versionId'],
  ["Record Astra's review of this version with live_correction.record_review first."],
);
export const DECIDED: CommandRefusal = refuseCommand(
  'GATE_ALREADY_DECIDED',
  [],
  ['This correction is decided already.'],
);
const STALE = refuseCommand(
  'VERSION_STALE',
  ['versionId'],
  ['Read the correction again and approve the version it shows.'],
);
const NOT_READY = refuseCommand(
  'VERSION_NOT_READY',
  ['versionId'],
  ['This correction has no version to decide: ask for the change again.'],
);
const UNVERIFIED = refuseCommand(
  'VERSION_UNVERIFIED',
  ['versionId'],
  ['The page has not been checked in the last minute. Read the correction again shortly.'],
);
/** States with no version a decision may name (#1693, the guard order's first step). */
const UNREADY = new Set(['locating', 'unlocated', 'superseded']);
const DECISION_FIXES: readonly string[] = ['A decision is approve or reject.'];

/**
 * Whether single-operator mode admits the requester acting on their own correction: the mode on
 * and one operator, both read after a share lock on the mode's row, which the membership trigger
 * takes for update whenever it makes an operator.
 */
export async function singleOperatorStands(tx: TenantQuery): Promise<boolean> {
  if (!(await lockSingleOperatorMode(tx, 'share'))) return false;
  return (await operatorCount(tx)) === 1;
}

/** The business's first single-operator approval rests on Astra's approving review of this version. */
async function reviewed(tx: TenantQuery, correction: LiveCorrection): Promise<boolean> {
  if (await hasSelfApproved(tx)) return true;
  return await reviewApproves(tx, correction.id, correction.versionDigest);
}

export async function decideLiveCorrection(
  tx: TenantQuery,
  context: CommandContext,
  request: Of<'live_correction.decide'>,
): Promise<HandlerOutcome> {
  if (request.decision !== 'approve' && request.decision !== 'reject') {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['decision'], DECISION_FIXES));
  }
  const { session } = context;
  if (!isInternalReader(session.roleKey)) return refused(NOT_THE_APPROVER);
  // A malformed id names no correction, as a fabricated one does.
  if (!isUuid(request.correctionId)) return refused(NOT_VISIBLE);
  const gate = { subjects: subjectsOf(session), collection: GATE_COLLECTION, action: 'decide' };
  const correction = await lockCoveredCorrection(tx, request.correctionId, gate);
  if (correction === undefined) return refused(NOT_VISIBLE);
  const self = correction.requestedByPersonId === session.personId;
  if (self && (request.decision !== 'approve' || !(await singleOperatorStands(tx)))) {
    return refused(SELF);
  }
  const approver = await lockConfiguredApprover(tx);
  if (approver === undefined || !(await isActiveMember(tx, approver))) {
    return refused(UNCONFIGURED);
  }
  if (approver.toLowerCase() !== session.personId) return refused(NOT_THE_APPROVER);
  // The guard order (#1693): no version yet, then decided, then the version, then its check.
  if (UNREADY.has(correction.state)) return refused(NOT_READY);
  if (correction.state !== 'requested') return refused(DECIDED);
  if (correction.versionId !== request.versionId.toLowerCase()) return refused(STALE);
  if (self && !(await reviewed(tx, correction))) return refused(REVIEW_MISSING);
  const approve = request.decision === 'approve';
  if (approve && !(await isVerifiedNow(tx, correction.id))) return refused(UNVERIFIED);
  const after = await decisionRefusal(tx, correction, { gate, unseen: NOT_VISIBLE });
  if (after !== undefined) return refused(after);

  // The approval is decided here, its check read again after every wait above.
  const decided = await writeCorrectionDecision(tx, {
    id: correction.id,
    decision: approve ? 'approved' : 'rejected',
    actorId: session.actorId,
    personId: session.personId,
    selfApproval: self,
  });
  if (decided === undefined) return refused(UNVERIFIED);
  return applied(decided.id, decided.revision, {
    correctionId: decided.id,
    versionId: decided.versionId,
    state: decided.state,
    singleOperatorSelfApproval: decided.singleOperatorSelfApproval,
  });
}
