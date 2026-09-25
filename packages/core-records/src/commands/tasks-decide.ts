// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.decide`: a person's decision on a gate. Split out
// unchanged when the one task-runtime module was divided (thermo review
// b483399, H2).

import type { TenantQuery } from '../tenancy/database.ts';
import { subjectsOf } from '../authority/grants.ts';
import { decide, type DecisionKind } from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { fromReasoned, refuseCommand, type CommandRefusal } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { gateSigningKey, readBusinessCapId } from './runtime-config.ts';

export interface DecideFields {
  readonly gateId: string;
  /** The exact version the caller read. Compared under the locks, never trusted. */
  readonly versionId: string;
  readonly decision: string;
  readonly note: string;
}

const DECISIONS: readonly DecisionKind[] = ['approve', 'reject', 'request_changes'];

function isDecisionKind(decision: string): decision is DecisionKind {
  return (DECISIONS as readonly string[]).includes(decision);
}

/** `task.decide`'s answer for a gate not visible here. Constant, so nothing presented rides out. */
const GATE_NOT_VISIBLE: CommandRefusal = refuseCommand(
  'NOT_FOUND',
  [],
  ['No gate by that identity in this business.', 'Name a gate on a task you can see.'],
);

export async function decideOnGate(
  tx: TenantQuery,
  context: CommandContext,
  fields: DecideFields,
): Promise<HandlerOutcome> {
  const decision = fields.decision;
  if (!isDecisionKind(decision)) {
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        ['decision'],
        ['A decision is approve, reject or request_changes.'],
      ),
      { decision },
    );
  }

  const signingKey = gateSigningKey();
  if (signingKey === undefined) {
    // Not a refusal about the caller. The chain is signed or it is not written,
    // and a deployment with no key configured has not built the part this
    // command rests on, which is what this code has always meant.
    return refused(
      refuseCommand(
        'DEPENDENCY_NOT_LANDED',
        ['task.decide', 'GATE_SIGNING_KEY_ID and GATE_SIGNING_SECRET'],
        [
          'This deployment has no decision signing key configured.',
          'It is not a permission problem and retrying will not change it.',
        ],
      ),
    );
  }

  const capId = await readBusinessCapId(tx);
  if (capId === undefined) {
    return refused(
      refuseCommand(
        'BUDGET_UNAVAILABLE',
        ['budget_caps.local'],
        [
          'This business has no budget cap, so there is nothing an approval could draw on.',
          'An administrator installs the cap; a decision does not create one.',
        ],
      ),
    );
  }

  const result = await decide(tx, {
    gateId: fields.gateId,
    versionId: fields.versionId,
    decidedByPersonId: context.session.personId,
    decidedByActorId: context.session.actorId,
    subjects: subjectsOf(context.session),
    collection: context.declaration.collection,
    decision,
    note: fields.note,
    signingKey,
    capId,
  });
  if (!result.ok) {
    // A gate this business cannot see is `NOT_FOUND`, whether it is another
    // business's or no gate at all, and the answer is the same bytes for both:
    // no presented id, no reason fragment (minimum contract 8.2 cases 1-2,
    // root ruling 2 of dd30aa8). The refused audit row is still this
    // business's, written by the envelope.
    if (result.refusal.code === 'GATE_NOT_FOUND') return refused(GATE_NOT_VISIBLE);
    // The runtime refuses a note it cannot sign and store (final review R1
    // #53). The field is named here, as every other `FIELD_VALUE_INVALID`
    // names its field; the value itself is not echoed.
    if (result.refusal.code === 'FIELD_VALUE_INVALID') {
      return refused(
        refuseCommand('FIELD_VALUE_INVALID', ['note'], [result.refusal.reason, result.refusal.fix]),
      );
    }
    return refused(fromReasoned(result.refusal));
  }

  const decided = result.value;
  return applied(null, null, {
    decisionId: decided.decisionId,
    gateId: decided.gateId,
    versionId: decided.versionId,
    decision: decided.decision,
    hash: decided.hash,
    ...(decided.decision === 'approve'
      ? {
          envelopeId: decided.envelopeId,
          reservationId: decided.reservationId,
          attemptId: decided.attemptId,
          heldMinor: decided.heldMinor,
        }
      : {}),
  });
}
