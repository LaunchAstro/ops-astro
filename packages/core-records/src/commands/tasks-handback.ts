// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.handback`: a lease settled, with its report and any successor. Moved out of
// `tasks-runtime.ts` unchanged (thermo review b282216, H2).

import type { TenantQuery } from '../tenancy/database.ts';
import { handback, type SuccessorRequest } from '../../../core-runtime/src/index.ts';
import type { HandbackHolder } from '../../../core-runtime/src/handback.ts';
import type { CommandContext } from './context.ts';
import { isIdentifier } from './operands.ts';
import { fromReasoned, refuseCommand } from './refusal.ts';
import { applied, refused, refusedRetaining, type HandlerOutcome } from './outcome.ts';
import { readSuccessor } from './successor.ts';
import { NO_SUCH_LEASE } from './tasks-lease.ts';
import { agentClaimant, personClaimant, type Claimant } from './tasks-claimant.ts';

export interface HandbackFields {
  readonly leaseId: string;
  readonly fence: number;
  readonly outcome: string;
  readonly report?: Readonly<Record<string, unknown>>;
  /** Declared only so that sending one is a refusal rather than a silence. */
  readonly actualMinor?: number | null;
  /**
   * The successor the caller asks for, exactly as the body carried it.
   *
   * `unknown` rather than a shape, because this is the boundary that decides
   * whether the body is a shape at all: an HTTP body is untyped, and a field
   * typed here would be a field the surface believed without reading. Absent
   * is the ordinary handback and anything else is read by `readSuccessor`.
   */
  readonly successor?: unknown;
}

export const OUTCOMES: ReadonlySet<string> = new Set(['completed', 'failed']);

/**
 * The handback refusals that have already written a report row L4 keeps.
 *
 * `core-runtime/src/handback.ts` calls its `retain` helper on exactly these
 * two before refusing, and `ACTUAL_EXPENDITURE_UNSUPPORTED` is deliberately
 * not among them: R6 refuses that one before the first write, so there is
 * nothing to keep.
 */
const RETAINING_REFUSALS: ReadonlySet<string> = new Set(['LEASE_NOT_OWNED', 'LEASE_EXPIRED']);

/**
 * The hold released, and `actualMinor` is `null` rather than a number.
 *
 * Nothing in this head dispatches, so nothing was spent, and the reservation
 * goes to `abandoned` rather than to a zero `actual`. A zero actual would be a
 * claim that the work ran and cost nothing, and the schema refuses it:
 * `reservations_actual_only_when_actual` makes carrying a number and being
 * `actual` the same fact. There is no payload field for it because there is no
 * honest value a caller could put in one.
 */
export async function handbackLease(
  tx: TenantQuery,
  fields: HandbackFields,
  agentActorId: string,
): Promise<HandlerOutcome> {
  return await settle(tx, fields, agentClaimant(agentActorId));
}

/**
 * The person hands back the lease their own pickup took. Ownership and current
 * write are checked by the runtime under the handback's locks, before any
 * report, settlement or successor is written; a successor is proposed as the
 * person's own actor.
 */
export async function handbackOwnLease(
  tx: TenantQuery,
  context: CommandContext,
  fields: HandbackFields,
): Promise<HandlerOutcome> {
  return await settle(tx, fields, personClaimant(context));
}

/** The runtime's holder for a claimant: who must own the lease, and under what. */
function holderOf(claimant: Claimant): HandbackHolder {
  return claimant.claimant === 'agent'
    ? { claimant: 'agent', actorId: claimant.actorId }
    : {
        claimant: 'person',
        actorId: claimant.actorId,
        subjects: claimant.subjects,
        collection: claimant.collection,
      };
}

async function settle(
  tx: TenantQuery,
  fields: HandbackFields,
  claimant: Claimant,
): Promise<HandlerOutcome> {
  if (!OUTCOMES.has(fields.outcome)) {
    return refused(
      refuseCommand('FIELD_VALUE_INVALID', ['outcome'], ['An outcome is completed or failed.']),
      { outcome: fields.outcome },
    );
  }
  if (!Number.isSafeInteger(fields.fence) || fields.fence < 0) {
    return refused(
      refuseCommand('FIELD_VALUE_INVALID', ['fence'], ['Send the fence the pickup handed you.']),
      { fence: fields.fence },
    );
  }
  // Root ruling 2 (ROOT-01a437a): a present report is an object of named
  // values. Null, an array or a string is refused by name, never spread into
  // an object with numeric keys; absent is an empty report.
  const report: unknown = fields.report;
  if (
    report !== undefined &&
    (typeof report !== 'object' || report === null || Array.isArray(report))
  ) {
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        ['report'],
        ['Send report as an object of named values, or leave it out.'],
      ),
      { report },
    );
  }
  // L4's `handback` answers `ACTUAL_EXPENDITURE_UNSUPPORTED` for any non-null
  // `actualMinor`, and the command says so here rather than discarding the
  // key. Dropping it quietly is the failure D06 exists to stop from the other
  // direction: the caller is left believing a spend figure was recorded when
  // nothing read it. `null` and absent are the same answer and both are fine.
  if (fields.actualMinor !== undefined && fields.actualMinor !== null) {
    return refused(
      refuseCommand(
        'ACTUAL_EXPENDITURE_UNSUPPORTED',
        ['actualMinor'],
        [
          'Leave actualMinor out, or send null: nothing in this head dispatches.',
          'A number here would claim the work ran and cost that much.',
        ],
      ),
      { actualMinor: fields.actualMinor },
    );
  }

  // The successor, read before the runtime is reached. Every refusal below is
  // about the body rather than about the lease, so it costs the caller nothing
  // it holds: the lease is still live and the work can be handed back again.
  let successor: SuccessorRequest | undefined;
  if (fields.successor !== undefined && fields.successor !== null) {
    const read = readSuccessor(fields.successor, claimant.actorId);
    if ('refusal' in read) return read;
    successor = read.successor;
  }

  // Both claimants come through here. A lease id that cannot exist names
  // nothing, and answers in the runtime's own bytes for a lease that does not
  // exist (`core-runtime/src/handback.ts:145-150`), never at a uuid parameter.
  if (!isIdentifier(fields.leaseId)) {
    return refused(refuseCommand('LEASE_NOT_OWNED', [], NO_SUCH_LEASE));
  }
  const result = await handback(tx, {
    leaseId: fields.leaseId,
    fence: fields.fence,
    outcome: fields.outcome as 'completed' | 'failed',
    report: { ...fields.report },
    actualMinor: null,
    ...(successor === undefined ? {} : { successor }),
    holder: holderOf(claimant),
  });
  if (!result.ok) {
    // R4, behavioural note 8. On these two paths the runtime has already
    // written the `handback_reports` row that keeps a stale holder's work, and
    // it says so in the row's `disposition = 'retained'`. The refusal and the
    // retained report are one fact and have to commit together, so this one
    // refusal is exempt from the savepoint every other refusal rolls back
    // through. The codes are named here rather than inferred, because a code
    // that starts retaining a row later should have to come and say so.
    return RETAINING_REFUSALS.has(result.refusal.code)
      ? refusedRetaining(fromReasoned(result.refusal))
      : refused(fromReasoned(result.refusal));
  }

  const settled = result.value;
  return applied(null, null, {
    leaseId: settled.leaseId,
    reservationId: settled.reservationId,
    attemptId: settled.attemptId,
    reservationState: settled.reservationState,
    classification: settled.classification,
    envelopeHeldMinor: settled.envelopeHeldMinor,
    envelopeActualMinor: settled.envelopeActualMinor,
    // R4's durable report. Its identity is the only handle a caller has on the
    // row the handback retained, and a report nobody can name is a report
    // nobody can read.
    reportId: settled.reportId,
    // The successor's four durable handles, null throughout when none was
    // asked for. They are in the same detail as the settlement because they
    // were written in the same transaction: T4 wants "the durable
    // handback/proposal handles in one response", and a caller that had to go
    // looking for its own gate could not tell the two halves apart.
    successorVersionId: settled.successorVersionId,
    successorGateId: settled.successorGateId,
    successorRunId: settled.successorRunId,
    successorStepId: settled.successorStepId,
  });
}
