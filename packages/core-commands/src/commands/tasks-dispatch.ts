// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.dispatch` on both entries (T2c1). The operands are read and refused
// here as heartbeat reads them; the runtime (`core-runtime/src/dispatch.ts`)
// rechecks the four effect-time facts under its locks and marks the step. A
// person dispatches on the lease their own pickup took; an agent on its own,
// under the delegation its credential resolved to.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import { dispatch, leaseReason, type DispatchRequest } from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { isIdentifier } from './operands.ts';
import { refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { personClaimant } from './tasks-claimant.ts';

export interface DispatchFields {
  readonly leaseId: unknown;
  readonly fence: unknown;
}

type Lease = Pick<DispatchRequest, 'leaseId' | 'fence'>;

/** The one dispatch for both claimants: operands refused here, the lease dispatched by `run`. */
async function dispatchWith(
  fields: DispatchFields,
  run: (lease: Lease) => ReturnType<typeof dispatch>,
): Promise<HandlerOutcome> {
  if (typeof fields.fence !== 'number' || !Number.isSafeInteger(fields.fence)) {
    return refused(
      refuseCommand('FIELD_VALUE_INVALID', ['fence'], ['Send the fence the pickup handed back.']),
    );
  }
  // A malformed id in the bytes a well-formed one naming nothing gets (root ruling 2).
  if (!isIdentifier(fields.leaseId)) {
    return refused(
      refuseCommand(
        'LEASE_NOT_OWNED',
        [],
        [
          leaseReason('not_owned'),
          'Dispatch under the lease your own pickup was issued, at its fence.',
        ],
      ),
    );
  }
  const result = await run({ leaseId: fields.leaseId, fence: fields.fence });
  if (!result.ok) return refused(result.refusal);
  const { taskId, dispatchedAt, ...marked } = result.value;
  return applied(taskId, null, { ...marked, dispatchedAt: dispatchedAt.toISOString() });
}

/** The person dispatches on their own lease, under their current rights. */
export async function dispatchOwnLease(
  tx: TenantQuery,
  context: CommandContext,
  fields: DispatchFields,
): Promise<HandlerOutcome> {
  const person = personClaimant(context);
  return await dispatchWith(
    fields,
    async (lease) =>
      await dispatch(tx, {
        claimant: 'person',
        ...lease,
        holderActorId: person.actorId,
        subjects: person.subjects,
        collection: person.collection,
      }),
  );
}

/** The agent dispatches on its own lease, under the delegation its credential resolved to. */
export async function dispatchLease(
  tx: TenantQuery,
  fields: DispatchFields,
  agent: { readonly actorId: string; readonly delegationId: string; readonly collection: string },
): Promise<HandlerOutcome> {
  return await dispatchWith(
    fields,
    async (lease) =>
      await dispatch(tx, {
        claimant: 'agent',
        ...lease,
        holderActorId: agent.actorId,
        delegationId: agent.delegationId,
        collection: agent.collection,
      }),
  );
}
