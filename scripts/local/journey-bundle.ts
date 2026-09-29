// SPDX-License-Identifier: AGPL-3.0-only
//
// T4d (T4-R7): the evidence bundle. Not built yet.

export interface Approval {
  readonly taskId: string;
  readonly decisionId: string;
  readonly decision: string;
  /** The decision row's payload exactly as the database holds it (`payload::text`). */
  readonly action: string;
}

export interface Bundle {
  readonly json: string;
  readonly markdown: string;
}

export interface BundleInput {
  readonly head: string;
  readonly tree: string;
  readonly clean: boolean;
  /** T2b's served-identity line from the end of the run. */
  readonly identity: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly cases: readonly {
    readonly case: string;
    readonly status: string;
    readonly detail: string;
  }[];
  readonly budgets: readonly Readonly<Record<string, string>>[];
  /** The restart legs' evidence, whose `runtime-proof` kill lines are the crash points. */
  readonly crashPoints: string;
  readonly approval: Approval | undefined;
}

export function writeBundle(_input: BundleInput): Bundle {
  return { json: '{}', markdown: '' };
}
