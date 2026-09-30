// SPDX-License-Identifier: AGPL-3.0-only
//
// Dispatch (C52-A, U36; migration 0053): the worker's step after the claim,
// under AW-01's lease (not on this branch). It rechecks, under the
// activation's lock, that the activation is on and the approval the
// occurrence recorded is still the one standing and unrevoked, and writes the
// result once. Only then is the run asked for, through the agent engine's
// starter.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import { lockActivation, readStandingApproval, type StandingApprovalRow } from './approvals.ts';
import type { ActivationRow } from './automations.ts';
import type { OccurrenceOutcome } from './occurrences.ts';

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

export type RunStarter = (tx: TenantQuery, run: RunRequest) => Promise<string>;

export type Dispatch =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'not_approved'; readonly outcome: OccurrenceOutcome }
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
 * occurrence waits for the first and answers `replayed` with its result.
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
  const runId =
    outcome === 'started'
      ? await startRun(tx, {
          occurrenceId,
          activationId: occurrence.activation_id,
          versionId: occurrence.version_id,
        })
      : null;
  const written = await tx.query<DispatchDbRow>(
    `insert into public.occurrence_dispatches (business_id, id, occurrence_id, outcome, run_id)
     values ((select public.app_business_id()), $1, $2, $3, $4)
     returning occurrence_id, outcome, run_id`,
    [randomUUID(), occurrenceId, outcome, runId],
  );
  if (written[0] === undefined) throw new Error('dispatchOccurrence: the dispatch was not written');
  return { kind: 'dispatched', dispatch: dispatchOf(written[0]) };
}
