// SPDX-License-Identifier: AGPL-3.0-only
//
// Dispatch (C52-A, U36; migration 0061): the worker's step after the claim,
// under AW-01's lease (not on this branch). It rechecks, under the
// activation's lock, that the activation is on and the approval the
// occurrence recorded is still the one standing and unrevoked, and writes the
// result once. Only then is the run asked for, through the starter the worker
// hands it (AW-01 J's write, `occurrenceRunStarter` in core-commands), which
// reads its approval and version facts here. A start the writer refuses
// writes nothing and records no dispatch, so the worker may dispatch again.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import { lockActivation, readStandingApproval, type StandingApprovalRow } from './approvals.ts';
import type { ActivationRow } from './automations.ts';
import { hasRoom, type DurableLimit } from '../tenancy/limit.ts';
import { FIRING_LIMITS, type OccurrenceOutcome } from './occurrences.ts';

export type DispatchOutcome = 'started' | 'activation_off' | 'approval_revoked' | 'approval_ended';

export interface DispatchRow {
  readonly occurrenceId: string;
  readonly outcome: DispatchOutcome;
  readonly runId: string | null;
}

export interface RunRequest {
  readonly occurrenceId: string;
  readonly activationId: string;
  readonly versionId: string;
}

/** A start the run's writer refused, by its refusal code; it wrote nothing. */
export interface RunRefused {
  readonly refused: string;
}

export type RunStarter = (tx: TenantQuery, run: RunRequest) => Promise<string | RunRefused>;

/** What the run's writer is told about an occurrence's approval and version. */
export interface OccurrenceFacts {
  readonly approvalId: string;
  readonly approvalState: 'standing' | 'revoked' | 'ended' | 'superseded';
  readonly approverActorId: string;
  readonly definitionId: string;
  readonly definitionVersionId: string;
  /** A released version is never withdrawn: it is immutable (0060). */
  readonly versionState: 'released';
  readonly contentDigest: string;
  readonly contentSize: number;
  /** Definitions are the business's own work and carry no client. */
  readonly clientId: null;
  readonly title: string;
}

export type Dispatch =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'not_approved'; readonly outcome: OccurrenceOutcome }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'dispatched' | 'replayed'; readonly dispatch: DispatchRow };

interface ClaimedDbRow {
  readonly activation_id: string;
  readonly version_id: string;
  readonly outcome: OccurrenceOutcome;
  readonly approval_id: string | null;
}

interface DispatchDbRow {
  readonly occurrence_id: string;
  readonly outcome: DispatchOutcome;
  readonly run_id: string | null;
}

interface FactsDbRow {
  readonly approval_id: string;
  readonly decided_by_actor_id: string;
  readonly definition_id: string;
  readonly version_id: string;
  readonly content_digest: string;
  readonly content_size: string;
  readonly name: string;
  readonly revoked: boolean;
  readonly enabled: boolean;
  readonly standing_id: string | null;
}

function approvalState(row: FactsDbRow): OccurrenceFacts['approvalState'] {
  if (row.revoked) return 'revoked';
  if (!row.enabled) return 'ended';
  return row.standing_id === row.approval_id ? 'standing' : 'superseded';
}

/**
 * The approval the occurrence recorded, the version it pins and its
 * definition, read in the caller's transaction (dispatch holds the
 * activation's lock), or undefined for an occurrence this business does not
 * have or one recorded without an approval.
 */
export async function readOccurrenceFacts(
  tx: TenantQuery,
  occurrenceId: string,
): Promise<OccurrenceFacts | undefined> {
  const rows = await tx.query<FactsDbRow>(
    `select s.id as approval_id, s.decided_by_actor_id, s.definition_id, s.version_id,
            v.content_digest, v.content_size::text, d.name, a.enabled, a.approval_id as standing_id,
            exists (select 1 from public.standing_approval_revocations r
                     where r.approval_id = s.id) as revoked
       from public.activation_occurrences o
       join public.standing_approvals s on s.id = o.approval_id
       join public.definition_versions v on v.id = s.version_id
       join public.automation_definitions d on d.id = s.definition_id
       join public.activations a on a.id = o.activation_id
      where o.id = $1`,
    [occurrenceId],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    approvalId: row.approval_id,
    approvalState: approvalState(row),
    approverActorId: row.decided_by_actor_id,
    definitionId: row.definition_id,
    definitionVersionId: row.version_id,
    versionState: 'released',
    contentDigest: row.content_digest,
    contentSize: Number(row.content_size),
    clientId: null,
    title: row.name,
  };
}

/** C33's run ceiling: this business's activation runs not yet handed back or cancelled. */
const runsInFlight: DurableLimit = {
  name: 'activation_run',
  limit: FIRING_LIMITS.runsInFlight,
  async count(tx) {
    const rows = await tx.query<{ readonly n: number }>(
      `select count(*)::int as n from public.planned_runs
        where origin_occurrence_id is not null and state not in ('handed_back', 'cancelled')`,
    );
    return rows[0]?.n ?? 0;
  },
};

const dispatchOf = (row: DispatchDbRow): DispatchRow => ({
  occurrenceId: row.occurrence_id,
  outcome: row.outcome,
  runId: row.run_id,
});

function dispatchOutcome(
  activation: ActivationRow | null,
  standing: StandingApprovalRow | null,
  recorded: string,
): DispatchOutcome {
  if (activation === null || !activation.enabled) return 'activation_off';
  if (standing?.id !== recorded) return 'approval_ended';
  return standing.revoked ? 'approval_revoked' : 'started';
}

/**
 * Dispatches an approved occurrence once. Under the activation's lock it
 * rechecks the switch and the approval, so an occurrence claimed before a
 * revoke or a turn-off starts nothing after it; a second dispatch of the same
 * occurrence waits for the first and answers `replayed` with its result. At
 * the business's run ceiling it answers `waiting` and writes nothing: the
 * occurrence stays listed as waiting until the worker dispatches it again
 * after a run finishes. The ceiling's lock is held to commit, so the run is
 * written before the next dispatch counts.
 */
export async function dispatchOccurrence(
  tx: TenantQuery,
  occurrenceId: string,
  startRun: RunStarter,
): Promise<Dispatch> {
  const claimed = await tx.query<ClaimedDbRow>(
    `select activation_id, version_id, outcome, approval_id
       from public.activation_occurrences where id = $1`,
    [occurrenceId],
  );
  const occurrence = claimed[0];
  if (occurrence === undefined) return { kind: 'unknown' };
  if (occurrence.outcome !== 'approved' || occurrence.approval_id === null) {
    return { kind: 'not_approved', outcome: occurrence.outcome };
  }
  const activation = await lockActivation(tx, occurrence.activation_id);
  const earlier = await tx.query<DispatchDbRow>(
    'select occurrence_id, outcome, run_id from public.occurrence_dispatches where occurrence_id = $1',
    [occurrenceId],
  );
  if (earlier[0] !== undefined) return { kind: 'replayed', dispatch: dispatchOf(earlier[0]) };
  const standing = await readStandingApproval(tx, occurrence.activation_id);
  const outcome = dispatchOutcome(activation, standing, occurrence.approval_id);
  let runId: string | null = null;
  if (outcome === 'started') {
    if (!(await hasRoom(tx, [runsInFlight]))) return { kind: 'waiting' };
    const started = await startRun(tx, {
      occurrenceId,
      activationId: occurrence.activation_id,
      versionId: occurrence.version_id,
    });
    if (typeof started !== 'string') return { kind: 'refused', code: started.refused };
    runId = started;
  }
  const written = await tx.query<DispatchDbRow>(
    `insert into public.occurrence_dispatches (business_id, id, occurrence_id, outcome, run_id)
     values ((select public.app_business_id()), $1, $2, $3, $4)
     returning occurrence_id, outcome, run_id`,
    [randomUUID(), occurrenceId, outcome, runId],
  );
  if (written[0] === undefined) throw new Error('dispatchOccurrence: the dispatch was not written');
  return { kind: 'dispatched', dispatch: dispatchOf(written[0]) };
}
