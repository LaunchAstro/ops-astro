// SPDX-License-Identifier: AGPL-3.0-only
//
// Dispatch (C52-A; migration 20261005060312): the worker's step after the
// claim. It rechecks, under the activation's lock, that the activation is on
// and that the approval the occurrence recorded is still the one standing and
// unrevoked, and writes the result once. Only then is the run asked for,
// through the starter the caller hands it; the agent engine's starter (AW-01
// J) is not wired here.
//
// Red: declared, and throws until it is built.

import type { TenantQuery } from '../tenancy/database.ts';
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

/** Starts the run in the dispatch's own transaction and answers its id. */
export type RunStarter = (tx: TenantQuery, run: RunRequest) => Promise<string>;

export type Dispatch =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'not_approved'; readonly outcome: OccurrenceOutcome }
  | { readonly kind: 'dispatched' | 'replayed'; readonly dispatch: DispatchRow };

export async function dispatchOccurrence(
  _tx: TenantQuery,
  _occurrenceId: string,
  _startRun: RunStarter,
): Promise<Dispatch> {
  return await Promise.reject(new Error('C52-A: not built'));
}
