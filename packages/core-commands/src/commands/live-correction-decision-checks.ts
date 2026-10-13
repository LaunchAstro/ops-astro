// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's approval checks beside the two commands (`live-corrections.ts`). A
// request is kept only while an approver is configured and still a staff
// member. A decision, once it holds the correction and the approver setting,
// asks three things again: that the page is still one its client's site binds,
// that the decider's gate grant still covers the client, and that the person
// who asked still holds run:write there, so a change is never approved on the
// word of someone who has lost it.

import {
  isActiveMember,
  isBoundPage,
  lockConfiguredApprover,
  RUN_COLLECTION,
} from '../../../core-records/src/index.ts';
import type { Covering, LiveCorrection, TenantQuery } from '../../../core-records/src/index.ts';
import { standsAfterWaits } from './live-correction-standing.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';

const REQUESTER_ENDED = refuseCommand(
  'REQUESTER_GRANT_ENDED',
  [],
  ['The person who asked no longer holds run:write at this client; they ask again.'],
);

/** The approver setting, share-locked so an unset in flight is waited for, naming an active member. */
export async function approverConfigured(tx: TenantQuery): Promise<boolean> {
  const approver = await lockConfiguredApprover(tx);
  return approver !== undefined && (await isActiveMember(tx, approver));
}

/**
 * What a decision may not approve after its waits, or undefined where it stands:
 * an unbound page or an ended gate grant is the caller's `unseen`.
 */
export async function decisionRefusal(
  tx: TenantQuery,
  correction: LiveCorrection,
  at: { readonly gate: Covering; readonly unseen: CommandRefusal },
): Promise<CommandRefusal | undefined> {
  // A page its client's site no longer binds names nothing this decision may
  // approve (a row from before the store held its pages).
  const page = { ...correction, path: correction.targetPath };
  if (!(await isBoundPage(tx, page))) return at.unseen;
  // The gate grant again after the waits: one that expired while the decision
  // waited covers nothing, as a grant that never did.
  const stood = await standsAfterWaits(tx, { covering: at.gate, partyId: correction.partyId });
  if (stood !== 'stands') return at.unseen;
  const { delegationId } = correction;
  const asker = await standsAfterWaits(tx, {
    covering: {
      subjects: [
        { kind: 'person', id: correction.requestedByPersonId },
        { kind: 'actor', id: correction.requestedByActorId },
      ],
      collection: RUN_COLLECTION,
      action: 'write',
    },
    partyId: correction.partyId,
    ...(delegationId === null ? {} : { delegationId }),
  });
  return asker === 'stands' ? undefined : REQUESTER_ENDED;
}
