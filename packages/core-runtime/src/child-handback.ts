// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-11: the helper's handback and the parent's merged result.
//
//   handBackChild   the helper's completed work, or its partial work with the
//                   refusal that stopped it, lands on the parent's run as a
//                   `child_handed_back` event and settles the child. A child
//                   revoked or run out may still hand back: partial work is
//                   kept, and a handback grants nothing. The parent's lease is
//                   not touched: its holder settles its own work.
//   childResults    the parent's view of its helpers: working, handed back
//                   (with the outcome and any refusal), or dropped with the
//                   fault named. Nothing here re-delegates: a replacement is
//                   the parent's own next call, never a guess. The parent is
//                   the caller's own, resolved from its credential.

import {
  digestOf,
  refuseCommand,
  registeredRefusal,
  settleDelegation,
} from '../../core-records/src/index.ts';
import type {
  CommandRefusal,
  Delegation,
  RefusalCode,
  TenantQuery,
} from '../../core-records/src/index.ts';
import type { ChildWorkResult } from './child-work.ts';
import { acquire } from './locks.ts';
import { only } from './only.ts';
import { appendRunEvent } from './run-events.ts';

export type ChildHandback =
  | { readonly outcome: 'completed' }
  | { readonly outcome: 'partial'; readonly refusal: RefusalCode };

export interface ChildResult {
  readonly childDelegationId: string;
  readonly helperActorId: string;
  readonly state: 'working' | 'handed_back' | 'dropped';
  readonly outcome: 'completed' | 'partial' | null;
  readonly refusal: string | null;
  readonly fault: 'DELEGATION_EXPIRED' | 'DELEGATION_REVOKED' | 'DELEGATION_NARROWED' | null;
}

const NOT_A_CHILD = (): ChildWorkResult<never> => ({
  ok: false,
  refusal: refuseCommand(
    'DELEGATION_NOT_LIVE',
    [],
    ['no helper delegation answers to this credential', 'hand back once, with your own credential'],
  ),
});

/** A partial handback names a registered refusal; nothing else is a handback. */
function handbackRefusal(handback: ChildHandback): CommandRefusal | undefined {
  if (handback.outcome === 'completed') return undefined;
  if (
    handback.outcome === 'partial' &&
    typeof handback.refusal === 'string' &&
    registeredRefusal(handback.refusal) !== undefined
  ) {
    return undefined;
  }
  return refuseCommand(
    'COMMAND_BODY_INVALID',
    ['outcome', 'refusal'],
    ['Hand back completed work, or partial work naming the refusal that stopped it.'],
  );
}

export async function handBackChild(
  tx: TenantQuery,
  helper: { readonly agentActorId: string; readonly credential: string },
  handback: ChildHandback,
): Promise<ChildWorkResult<{ readonly childDelegationId: string }>> {
  const invalid = handbackRefusal(handback);
  if (invalid !== undefined) return { ok: false, refusal: invalid };
  const found = await openChild(tx, helper);
  if (found === undefined) return NOT_A_CHILD();
  const locks = await acquire(tx, [
    { lockClass: 'task', id: found.task_id },
    { lockClass: 'delegation', id: found.id },
  ]);
  // Re-read under the lock: a second handback that waited sees this one settled.
  const open = await tx.query(
    `select 1 from public.delegations where business_id = $1 and id = $2 and settled_at is null`,
    [tx.businessId, found.id],
  );
  if (open.length === 0) return NOT_A_CHILD();
  await settleDelegation(tx, found.id);
  await appendRunEvent(
    tx,
    {
      kind: 'child_handed_back',
      taskId: found.task_id,
      runId: found.run_id,
      leaseId: found.lease_id,
      attemptId: found.attempt_id,
      actorId: helper.agentActorId,
      detail: {
        childDelegationId: found.id,
        outcome: handback.outcome,
        refusal: handback.outcome === 'partial' ? handback.refusal : null,
      },
    },
    locks,
  );
  return { ok: true, value: { childDelegationId: found.id } };
}

interface OpenChild {
  readonly id: string;
  readonly lease_id: string;
  readonly task_id: string;
  readonly run_id: string;
  readonly attempt_id: string;
}

/**
 * The helper's own unsettled child, by agent and credential digest together
 * (a child credential presented by another agent, or a parent's, names
 * nothing), with the parent's lease, run and attempt its handback lands on.
 */
async function openChild(
  tx: TenantQuery,
  helper: { readonly agentActorId: string; readonly credential: string },
): Promise<OpenChild | undefined> {
  const rows = await tx.query<OpenChild>(
    `select d.id, l.id as lease_id, l.task_id, l.run_id, att.id as attempt_id
       from public.delegations d
       join public.leases l on l.business_id = d.business_id and l.delegation_id = d.parent_delegation_id
       join public.attempts att on att.business_id = l.business_id and att.lease_id = l.id
      where d.business_id = $1 and d.agent_actor_id = $2 and d.credential_hash = $3
        and d.parent_delegation_id is not null and d.settled_at is null`,
    [tx.businessId, helper.agentActorId, digestOf(helper.credential)],
  );
  return rows.length === 0 ? undefined : only(rows, "handBackChild: the child's parent lease");
}

interface ChildRow {
  readonly id: string;
  readonly agent_actor_id: string;
  readonly expired: boolean;
  readonly revoked: boolean;
  readonly cause: string | null;
  readonly outcome: 'completed' | 'partial' | null;
  readonly refusal: string | null;
}

export async function childResults(
  tx: TenantQuery,
  parent: Delegation,
): Promise<readonly ChildResult[]> {
  const rows = await tx.query<ChildRow>(
    `select d.id, d.agent_actor_id, d.expires_at <= now() as expired,
            d.revoked_at is not null as revoked, d.revocation_cause as cause,
            ev.detail ->> 'outcome' as outcome, ev.detail ->> 'refusal' as refusal
       from public.delegations d
       left join public.run_events ev
         on ev.business_id = d.business_id and ev.kind = 'child_handed_back'
        and ev.detail ->> 'childDelegationId' = d.id::text
      where d.business_id = $1 and d.parent_delegation_id = $2
      order by d.id`,
    [tx.businessId, parent.id],
  );
  return rows.map((row) => resultOf(row));
}

/** Handed back, else dropped with its fault (expiry first, as the walk reads it), else working. */
function resultOf(row: ChildRow): ChildResult {
  const handedBack = row.outcome !== null;
  const fault = handedBack ? null : faultOf(row);
  return {
    childDelegationId: row.id,
    helperActorId: row.agent_actor_id,
    state: handedBack ? 'handed_back' : fault === null ? 'working' : 'dropped',
    outcome: row.outcome,
    refusal: handedBack ? row.refusal : null,
    fault,
  };
}

function faultOf(row: ChildRow): ChildResult['fault'] {
  if (row.expired) return 'DELEGATION_EXPIRED';
  if (!row.revoked) return null;
  return row.cause === 'authority_lost' ? 'DELEGATION_NARROWED' : 'DELEGATION_REVOKED';
}
