// SPDX-License-Identifier: AGPL-3.0-only
//
// Escalation on a gate (T3a). At the revision bound a decider may hand the
// gate to a person holding decide across the business who is not the task's
// assignee; the gate stays pending, and from then on only such a person
// decides it. Split out of `decide.ts` to keep that file under its 1,000
// lines: `decide` calls these under the locks it already holds, and the
// reasoning for the locks is there. `assignedTo` is here because both the
// recipient check and `decide`'s four eyes read it.

import { refuseCommand } from '../../core-records/src/index.ts';
import type { Subject, TenantQuery } from '../../core-records/src/index.ts';
import { checkAuthorityAt } from './recovery.ts';
import { refuse, type RuntimeResult } from './refusals.ts';

/** What the escalation checks read from a decision request (`DecideRequest`). */
export interface EscalationAsk {
  readonly subjects: readonly Subject[];
  readonly collection: string;
  readonly decision: string;
  readonly decidedByPersonId: string;
  readonly decidedByActorId: string;
  /** Escalate's recipient: a person who must hold decide at business scope. */
  readonly recipientPersonId?: string;
}

/** An escalation's answer: not the gate's decision, so no signed row and no hash. */
export interface Escalated {
  readonly decision: 'escalate';
  readonly gateId: string;
  readonly versionId: string;
  readonly escalatedToPersonId: string;
}

/**
 * An escalated gate is decided only by the escalation role: decide at
 * business scope, read at the locked instant like the task-scope grant.
 */
export async function escalatedDecider(
  tx: TenantQuery,
  request: EscalationAsk,
  escalated: boolean,
  lockedAt: string,
): Promise<RuntimeResult<null>> {
  if (!escalated) return { ok: true, value: null };
  const wider = await checkAuthorityAt(
    tx,
    request.subjects,
    { collection: request.collection, action: 'decide', scope: { kind: 'business', id: null } },
    lockedAt,
  );
  if (!wider.ok) {
    return refuse(
      'SCOPE_NOT_GRANTED',
      'this gate was escalated, and only a holder of decide across the business decides it now',
      'A person holding decide at business scope decides or escalates it.',
    );
  }
  return { ok: true, value: null };
}

/**
 * Escalate is offered at the bound only (G08's two formal rounds used), and
 * to a recipient who holds the escalation role. Any other decision passes.
 */
export async function recheckEscalation(
  tx: TenantQuery,
  request: EscalationAsk,
  taskId: string,
  lockedAt: string,
  atBound: () => Promise<boolean>,
): Promise<RuntimeResult<null>> {
  if (request.decision !== 'escalate') return { ok: true, value: null };
  if (!(await atBound())) {
    return refuse(
      'TRANSITION_NOT_PERMITTED',
      'escalation is offered once this lineage has used its two rounds of changes',
      'Approve, reject or request changes; escalate at the bound.',
    );
  }
  return await recheckRecipient(tx, request, taskId, lockedAt);
}

/** Whether the task is assigned to this person, or to their agent, read under the caller's task lock. */
export async function assignedTo(
  tx: TenantQuery,
  taskId: string,
  personId: string,
): Promise<boolean> {
  const rows = await tx.query<{ readonly mine: boolean }>(
    // An agent assignee counts as its delegating person (Assign to AI).
    `select exists (select 1 from public.records r
                     where r.business_id = $1 and r.id = $2
                       and (r.uuid_2 = $3
                            or exists (select 1 from public.delegations d
                                        where d.business_id = r.business_id
                                          and d.id::text = r.data ->> 'agent'
                                          and d.delegate_person_id = $3))) as mine`,
    [tx.businessId, taskId, personId],
  );
  return rows[0]?.mine === true;
}

/**
 * The recipient holds the escalation role at the locked instant: decide at
 * business scope, through the person or any of their actors, and is not the
 * task's assignee, whom four eyes keeps from deciding. Anyone else, or nobody,
 * fails closed and the gate stays as it was, approve and reject still open.
 * The answer names the field and never echoes the presented id.
 */
async function recheckRecipient(
  tx: TenantQuery,
  request: EscalationAsk,
  taskId: string,
  lockedAt: string,
): Promise<RuntimeResult<null>> {
  const ineligible = {
    ok: false as const,
    refusal: refuseCommand(
      'SCOPE_NOT_GRANTED',
      ['recipientPersonId'],
      [
        'the recipient does not hold decide across this business',
        'Escalate to a person holding decide at business scope who is not assigned the task.',
      ],
    ),
  };
  const recipient = request.recipientPersonId;
  if (recipient === undefined) return ineligible;
  const actors = await tx.query<{ readonly id: string }>(
    `select id from public.actors where business_id = $1 and person_id = $2`,
    [tx.businessId, recipient],
  );
  if (actors.length === 0) return ineligible;
  const held = await checkAuthorityAt(
    tx,
    [
      { kind: 'person', id: recipient },
      ...actors.map((actor) => ({ kind: 'actor' as const, id: actor.id })),
    ],
    { collection: request.collection, action: 'decide', scope: { kind: 'business', id: null } },
    lockedAt,
  );
  if (!held.ok || (await assignedTo(tx, taskId, recipient))) return ineligible;
  return { ok: true, value: null };
}

/**
 * Escalate (T3a): the actor and the recipient on the gate, under the gate
 * lock. The gate stays `pending` and no decision is written, so the chain and
 * the one-decision-per-gate index are untouched; a later escalation replaces
 * the recipient, and each one is in the audit trail.
 */
export async function escalateGate(
  tx: TenantQuery,
  request: EscalationAsk,
  gate: { readonly id: string; readonly version_id: string },
): Promise<{ readonly ok: true; readonly value: Escalated }> {
  const recipient = request.recipientPersonId;
  if (recipient === undefined) {
    throw new Error('decide: escalate reached its write without a checked recipient');
  }
  await tx.query(
    `update public.gates
        set escalated_to_person_id = $3, escalated_by_person_id = $4,
            escalated_by_actor_id = $5, escalated_at = now()
      where business_id = $1 and id = $2`,
    [tx.businessId, gate.id, recipient, request.decidedByPersonId, request.decidedByActorId],
  );
  return {
    ok: true,
    value: {
      decision: 'escalate',
      gateId: gate.id,
      versionId: gate.version_id,
      escalatedToPersonId: recipient,
    },
  };
}
