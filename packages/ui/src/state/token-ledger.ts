// SPDX-License-Identifier: AGPL-3.0-only
//
// The token panel's reading of a task's ledger (MP-6-5, DA-08, DA-09,
// DS-TASK-9): `task.read`'s ledger and proposals, shaped as the read returns
// them.

/** One envelope on the task, as `task.read`'s ledger carries it. */
export interface LedgerEnvelope {
  readonly id: string;
  readonly state: string;
  /** The allowance. */
  readonly maximumMinor: number;
  readonly heldMinor: number;
  /** Spent. */
  readonly actualMinor: number;
  readonly currency: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  /** The approval whose reservation opened it. */
  readonly openedBy: { readonly versionId: string } | null;
  /** The cap it draws on. */
  readonly cap: { readonly key: string; readonly limitMinor: number; readonly currency: string };
}

/** The task's ledger: the open envelope first, then the closed ones, newest first. */
export interface TaskLedger {
  readonly envelopes: readonly LedgerEnvelope[];
}
