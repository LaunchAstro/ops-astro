// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.observe` on both entries (T2c2). The operands are refused here as
// dispatch refuses them; the operation register is asked whether the effect
// happened, under the identity derived from the attempt; the runtime
// (`core-runtime/src/observe.ts`) holds the lease, its token and its hold to
// the caller under its locks and records the observation. T2d: the worker's
// usage report and its word that a step failed ride along, and the runtime
// settles the hold at the book's price. A cost above the hold is refused, and
// the refusal keeps the attempt held as an unknown liability, with the
// observed amount on its audit event.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import { leaseReason, observe, type ObserveRequest } from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { isIdentifier } from './operands.ts';
import { refuseCommand } from './refusal.ts';
import { applied, refused, refusedRetaining, type HandlerOutcome } from './outcome.ts';
import { personClaimant } from './tasks-claimant.ts';
import { lookupEffect } from './register-store.ts';

export interface ObserveFields {
  readonly leaseId: unknown;
  readonly fence: unknown;
  readonly attemptId: unknown;
  readonly usage?: unknown;
  readonly outcome?: unknown;
  readonly receiptLink?: unknown;
}

/** Who asks: the verified caller, never a body field; an agent under its resolved delegation. */
type Holder = ObserveRequest extends infer R
  ? R extends unknown
    ? Omit<R, 'leaseId' | 'fence' | 'attemptId' | 'effect' | 'usage' | 'outcome' | 'receiptLink'>
    : never
  : never;

interface Operands {
  readonly leaseId: string;
  readonly fence: number;
  readonly attemptId: string;
  readonly outcome: 'completed' | 'failed';
}

/** The operands as read, or their refusal, refused as dispatch refuses them. */
function readOperands(fields: ObserveFields): Operands | { readonly refusal: HandlerOutcome } {
  if (typeof fields.fence !== 'number' || !Number.isSafeInteger(fields.fence)) {
    return {
      refusal: refused(
        refuseCommand('FIELD_VALUE_INVALID', ['fence'], ['Send the fence the pickup handed back.']),
      ),
    };
  }
  const outcome = fields.outcome ?? 'completed';
  if (outcome !== 'completed' && outcome !== 'failed') {
    return {
      refusal: refused(
        refuseCommand(
          'FIELD_VALUE_INVALID',
          ['outcome'],
          ['Send completed or failed, or leave it out.'],
        ),
      ),
    };
  }
  // A malformed lease or token in the bytes a well-formed one naming nothing gets.
  if (!isIdentifier(fields.leaseId) || !isIdentifier(fields.attemptId)) {
    return {
      refusal: refused(
        refuseCommand(
          'LEASE_NOT_OWNED',
          [],
          [
            leaseReason('not_owned'),
            'Observe under the lease your own pickup was issued, with its attempt.',
          ],
        ),
      ),
    };
  }
  return { leaseId: fields.leaseId, fence: fields.fence, attemptId: fields.attemptId, outcome };
}

async function observeAs(
  tx: TenantQuery,
  fields: ObserveFields,
  holder: Holder,
): Promise<HandlerOutcome> {
  const operands = readOperands(fields);
  if ('refusal' in operands) return operands.refusal;
  const { attemptId } = operands;
  const result = await observe(tx, {
    ...holder,
    leaseId: operands.leaseId,
    fence: operands.fence,
    attemptId,
    effect: async () => await lookupEffect(tx, holder.holderActorId, attemptId),
    usage: fields.usage,
    outcome: operands.outcome,
    receiptLink: fields.receiptLink,
  });
  if (!result.ok) return refused(result.refusal);
  const { taskId, ...observed } = result.value;
  const { settlement } = observed;
  if (settlement.state === 'liability_unknown') {
    return refusedRetaining(
      refuseCommand(
        'BUDGET_UNAVAILABLE',
        [],
        [
          `the reported cost ${settlement.observedMinor} is more than the ${settlement.heldMinor} held`,
          'Nothing was settled. The attempt is held at its maximum as an unknown liability until a person records its outcome.',
        ],
      ),
      { observedMinor: settlement.observedMinor },
    );
  }
  return applied(taskId, null, observed);
}

/** The person observes on their own lease, under their current rights. */
export async function observeOwnLease(
  tx: TenantQuery,
  context: CommandContext,
  fields: ObserveFields,
): Promise<HandlerOutcome> {
  const person = personClaimant(context);
  return await observeAs(tx, fields, {
    claimant: 'person',
    holderActorId: person.actorId,
    subjects: person.subjects,
    collection: person.collection,
  });
}

/** The agent observes on its own lease, under the delegation its credential resolved to. */
export async function observeLease(
  tx: TenantQuery,
  fields: ObserveFields,
  agent: { readonly actorId: string; readonly delegationId: string; readonly collection: string },
): Promise<HandlerOutcome> {
  return await observeAs(tx, fields, {
    claimant: 'agent',
    holderActorId: agent.actorId,
    delegationId: agent.delegationId,
    collection: agent.collection,
  });
}
