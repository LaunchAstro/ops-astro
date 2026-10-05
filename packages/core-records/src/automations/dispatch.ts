// SPDX-License-Identifier: AGPL-3.0-only
//
// Dispatch (C52-A; migration 20261005193201): the worker's step after the
// claim. It rechecks, under the activation's lock, that the activation is on
// and that the approval the occurrence recorded is still the one standing and
// unrevoked, and writes the result once. Only then is the run asked for,
// through the starter the caller hands it; the agent engine's starter (AW-01
// J) is not wired here.

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

/** A start the run's writer refused, by its refusal code; it wrote nothing. */
export interface RunRefused {
  readonly refused: string;
}

/** Starts the run in the dispatch's own transaction and answers its id, or the writer's refusal. */
export type RunStarter = (tx: TenantQuery, run: RunRequest) => Promise<string | RunRefused>;

/** What the run's writer (AW-01 J) is told about an occurrence's approval and version. */
export interface OccurrenceFacts {
  readonly approvalId: string;
  readonly approvalState: 'standing' | 'revoked' | 'ended' | 'superseded';
  readonly approverActorId: string;
  readonly definitionId: string;
  readonly definitionVersionId: string;
  /** A released version is never withdrawn: it is immutable (20261005003850). */
  readonly versionState: 'released';
  readonly contentDigest: string;
  readonly contentSize: number;
  /** Definitions are the business's own work and carry no client. */
  readonly clientId: null;
  readonly title: string;
}

/** The facts the run's writer reads for an occurrence. Not yet read. */
export async function readOccurrenceFacts(
  _tx: TenantQuery,
  _occurrenceId: string,
): Promise<OccurrenceFacts | undefined> {
  const none: OccurrenceFacts[] = [];
  return await Promise.resolve(none[0]);
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
 * rechecks the switch and the approval, each read in a statement after the
 * lock is held, so an occurrence claimed before a revoke or a turn-off starts
 * nothing once that change has committed; a second dispatch of the same
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
  const started =
    outcome === 'started'
      ? await startRun(tx, {
          occurrenceId,
          activationId: occurrence.activation_id,
          versionId: occurrence.version_id,
        })
      : null;
  const runId = typeof started === 'string' ? started : null;
  const written = await tx.query<DispatchDbRow>(
    `insert into public.occurrence_dispatches (business_id, id, occurrence_id, outcome, run_id)
     values ((select public.app_business_id()), $1, $2, $3, $4)
     returning occurrence_id, outcome, run_id`,
    [randomUUID(), occurrenceId, outcome, runId],
  );
  if (written[0] === undefined) throw new Error('dispatchOccurrence: the dispatch was not written');
  return { kind: 'dispatched', dispatch: dispatchOf(written[0]) };
}
