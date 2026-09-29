// SPDX-License-Identifier: AGPL-3.0-only
//
// One row of the Projects board (MP-5-8): what its nine cells draw, as the
// screen maps it from the board's read. Values the product does not store
// yet are null or zero, never invented.

export type Estimate =
  | { readonly kind: 'time'; readonly minutes: number }
  | { readonly kind: 'tokens'; readonly tokens: number; readonly by: string };

export type Actual =
  | { readonly kind: 'time'; readonly minutes: number }
  | { readonly kind: 'tokens'; readonly tokens: number; readonly runs: number };

export interface ProjectRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly rank: { readonly number: number | null; readonly calc: string };
  readonly starred: boolean;
  readonly client: string | null;
  readonly assignee: { readonly name: string; readonly agent: boolean } | null;
  readonly due: string | null;
  readonly completed: boolean;
  readonly stage: string | null;
  readonly status: string;
  /** Where the status stands in the workflow, from its state record; null when unknown. */
  readonly statusPosition: number | null;
  /** Why the task waits, drawn after its group's heading; null for none. */
  readonly waitReason: string | null;
  readonly estimate: Estimate | null;
  readonly actual: Actual | null;
  readonly comments: {
    readonly client: number;
    readonly mentions: number;
    readonly latest: string | null;
  };
}
