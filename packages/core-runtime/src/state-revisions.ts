// SPDX-License-Identifier: AGPL-3.0-only
//
// What the run knows so far, revised under its worker lease (MP-6-2, CS-16.4).
//
// The caller holds the run's live lease, exactly as for a check
// (`lockOwnedLease`: the lease and any delegation locked, holder, fence,
// liveness and the authority behind it re-checked at one instant). A revision
// is `run:write`, so an agent's is re-checked at that same instant for that
// pair: the delegation carries it (fixed at mint) and its delegating person
// still holds it. The call-time check made both before any lock, and a grant
// revoked since would otherwise still write. A person's lease is re-checked
// on their own `run:write` by `lockOwnedLease` itself, whose collection is the
// command's.
//
// The number is the run's next, read under the lease lock, which every
// revision of the run takes; `run_state_revisions_numbered` is the backstop.
// The row takes its run, version and attempt from the lease's reservation,
// never from the body, and names the lease holder as its actor.

import { randomUUID } from 'node:crypto';
import { refuseCommand, type TenantQuery } from '../../core-records/src/index.ts';
import { lockOwnedLease, type LeaseCaller } from './heartbeat.ts';
import { LEASE_FIXES } from './lease-ownership.ts';
import { only } from './only.ts';
import { checkAuthorityAt } from './recovery.ts';
import type { RuntimeResult } from './refusals.ts';

export interface KnownFact {
  readonly k: string;
  readonly v: string;
}

export interface StaleInput {
  readonly k: string;
  readonly why: string;
}

export interface Knowledge {
  readonly step: string | null;
  readonly valid: readonly KnownFact[];
  readonly unknowns: readonly string[];
  readonly stale: readonly StaleInput[];
}

export type RevisionRequest = LeaseCaller & Knowledge;

export interface RecordedRevision {
  readonly revisionId: string;
  readonly revision: number;
  readonly taskId: string;
  readonly runId: string;
}

/** The pair a revision is, re-read under the locks for an agent's delegation. */
const PAIR = { collection: 'run', action: 'write' } as const;

async function agentStillCarries(
  tx: TenantQuery,
  delegationId: string,
  taskId: string,
  lockedAt: string,
): Promise<RuntimeResult<null>> {
  const [row] = await tx.query<{ readonly person: string; readonly carries: boolean }>(
    `select delegate_person_id as person, ($3 = any(pairs)) as carries
       from public.delegations where business_id = $1 and id = $2`,
    [tx.businessId, delegationId, `${PAIR.collection}:${PAIR.action}`],
  );
  if (row === undefined || !row.carries) {
    return {
      ok: false,
      refusal: refuseCommand(
        'DELEGATION_OUT_OF_PURPOSE',
        [],
        [
          'the delegation does not carry write on run',
          'ask the authorising person for a delegation whose purpose covers it',
        ],
      ),
    };
  }
  const held = await checkAuthorityAt(
    tx,
    [{ kind: 'person', id: row.person }],
    { ...PAIR, scope: { kind: 'record', id: taskId } },
    lockedAt,
  );
  if (held.ok) return { ok: true, value: null };
  return {
    ok: false,
    refusal: refuseCommand(
      'DELEGATION_NARROWED',
      [],
      [
        'the delegating person no longer holds write on run',
        'ask the authorising person to restore it, or hand the work back',
      ],
    ),
  };
}

export async function reviseState(
  tx: TenantQuery,
  request: RevisionRequest,
): Promise<RuntimeResult<RecordedRevision>> {
  const owned = await lockOwnedLease(tx, request, LEASE_FIXES.revise);
  if (!owned.ok) return owned;
  const { taskId, lockedAt } = owned.value;
  if (request.claimant === 'agent') {
    const still = await agentStillCarries(tx, request.delegationId, taskId, lockedAt);
    if (!still.ok) return still;
  }
  const revisionId = randomUUID();
  const written = await tx.query<{
    readonly task_id: string;
    readonly run_id: string;
    readonly revision: number;
  }>(
    `insert into public.run_state_revisions
       (business_id, id, task_id, run_id, version_id, lease_id, attempt_id, actor_id,
        fence, revision, step, valid, unknowns, stale, created_at)
     select l.business_id, $3, l.task_id, run.id, run.version_id, l.id, att.id,
            l.holder_actor_id, l.fence,
            coalesce((select max(prior.revision) from public.run_state_revisions prior
                       where prior.business_id = l.business_id and prior.run_id = run.id), 0) + 1,
            $4, $5::text::jsonb, $6::text::jsonb, $7::text::jsonb, $8::timestamptz
       from public.leases l
       join public.reservations res
         on res.business_id = l.business_id and res.lease_id = l.id
       join public.planned_runs run
         on run.business_id = res.business_id and run.id = res.run_id
       join public.attempts att
         on att.business_id = res.business_id and att.reservation_id = res.id
      where l.business_id = $1 and l.id = $2
     returning task_id, run_id, revision`,
    [
      tx.businessId,
      request.leaseId,
      revisionId,
      request.step,
      JSON.stringify(request.valid),
      JSON.stringify(request.unknowns),
      JSON.stringify(request.stale),
      lockedAt,
    ],
  );
  const row = only(written, 'reviseState: the live lease re-checked above, and its attempt');
  const value = { revisionId, revision: row.revision, taskId: row.task_id, runId: row.run_id };
  return { ok: true, value };
}
