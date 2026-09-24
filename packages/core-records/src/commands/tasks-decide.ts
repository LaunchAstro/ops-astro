// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.decide`: a person's decision on a gate. Split out
// unchanged when the one task-runtime module was divided (thermo review
// b282216, H2).

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

const DECISIONS: ReadonlySet<string> = new Set(['approve', 'reject', 'request_changes']);

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
  if (!DECISIONS.has(fields.decision)) {
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        ['decision'],
        ['A decision is approve, reject or request_changes.'],
      ),
      { decision: fields.decision },
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
    decision: fields.decision as DecisionKind,
    note: fields.note,
    signingKey,
    capId,
  });
  if (!result.ok) {
    // A gate this business cannot see is `NOT_FOUND`, whether it is another
    // business's or no gate at all, and the answer is the same bytes for both:
    // no presented id, no reason fragment (minimum contract 8.2 cases 1-2,
    // root ruling 2 of 906613f). The refused audit row is still this
    // business's, written by the envelope.
    if (result.refusal.code === 'GATE_NOT_FOUND') return refused(GATE_NOT_VISIBLE);
    return refused(fromReasoned(result.refusal));
  }

  const decided = result.value;
  return applied(null, null, {
    decisionId: decided.decisionId,
    gateId: decided.gateId,
    versionId: decided.versionId,
    decision: decided.decision,
    hash: decided.hash,
    ...(decided.envelopeId === undefined ? {} : { envelopeId: decided.envelopeId }),
    ...(decided.reservationId === undefined ? {} : { reservationId: decided.reservationId }),
    ...(decided.attemptId === undefined ? {} : { attemptId: decided.attemptId }),
    ...(decided.heldMinor === undefined ? {} : { heldMinor: decided.heldMinor }),
  });
}
