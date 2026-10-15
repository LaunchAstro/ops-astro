// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's revert ask, `live_correction.revert` (design rule A3): the configured
// approver asks, once, that a live correction be reverted. It is judged as the
// approval is (`live-corrections.ts`): a staff caller, the correction locked
// for update at its party under the caller's gate grant, the requester refused
// first, then the approver setting share-locked and read, then the state, and
// the gate grant read again after those waits. The ask is one row whose id the
// worker's revert step later names; nothing here calls a provider or a model.
//
// Refusals carry fixed text only: no word, path, page or content.

import {
  GATE_COLLECTION,
  insertRevertAsk,
  isActiveMember,
  isUuid,
  lockConfiguredApprover,
  lockCoveredCorrection,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import { isInternalReader } from '../reads/tasks.ts';
import type { CommandContext } from './context.ts';
import type { CommandRequest } from './requests.ts';
import { refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { standsAfterWaits } from './live-correction-standing.ts';

type RevertRequest = CommandRequest & { readonly command: 'live_correction.revert' };

const NOT_VISIBLE = refuseCommand(
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
  ['Only the configured staff approver asks for a live correction to be reverted.'],
);
const SELF = refuseCommand(
  'SELF_APPROVAL_REFUSED',
  [],
  ['A second person asks for the revert; ask the configured approver.'],
);
const NOT_LIVE = refuseCommand(
  'TRANSITION_NOT_PERMITTED',
  [],
  ['Only a live correction is reverted.', 'Read the correction again.'],
);
const ASKED = refuseCommand(
  'GATE_ALREADY_DECIDED',
  [],
  ['A revert of this correction is asked already.'],
);

export async function askLiveRevert(
  tx: TenantQuery,
  context: CommandContext,
  request: RevertRequest,
): Promise<HandlerOutcome> {
  const { session } = context;
  if (!isInternalReader(session.roleKey)) return refused(NOT_THE_APPROVER);
  // A malformed id names no correction, as a fabricated one does.
  if (!isUuid(request.correctionId)) return refused(NOT_VISIBLE);
  const gate = { subjects: subjectsOf(session), collection: GATE_COLLECTION, action: 'decide' };
  const correction = await lockCoveredCorrection(tx, request.correctionId, gate);
  if (correction === undefined) return refused(NOT_VISIBLE);
  if (correction.requestedByPersonId === session.personId) return refused(SELF);
  const approver = await lockConfiguredApprover(tx);
  if (approver === undefined || !(await isActiveMember(tx, approver))) {
    return refused(UNCONFIGURED);
  }
  if (approver.toLowerCase() !== session.personId) return refused(NOT_THE_APPROVER);
  if (correction.state !== 'live') return refused(NOT_LIVE);
  // The gate grant again after the approver setting's wait: one that ended
  // while the ask waited covers nothing, as a grant that never did.
  const stood = await standsAfterWaits(tx, { covering: gate, partyId: correction.partyId });
  if (stood !== 'stands') return refused(NOT_VISIBLE);

  const asked = await insertRevertAsk(tx, {
    correctionId: correction.id,
    actorId: session.actorId,
    personId: session.personId,
  });
  if (asked === undefined) return refused(ASKED);
  return applied(asked.id, null, { revertAskId: asked.id, correctionId: asked.correctionId });
}
