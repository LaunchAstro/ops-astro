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
  readonly assignee: {
    readonly id: string;
    readonly name: string;
    readonly agent: boolean;
  } | null;
  readonly due: string | null;
  readonly completed: boolean;
  readonly stage: string | null;
  readonly status: string;
  /** Where the status stands in the workflow, from its state record; null when unknown. */
  readonly statusPosition: number | null;
  /** Why the task waits, drawn after its group's heading; null for none. */
  readonly waitReason: string | null;
  /** The task's category, a chip on the board (MP-5-12); null for none. */
  readonly category: string | null;
  /** True when the task waits at an open gate for the viewer's decision (MP-5-12). */
  readonly awaitingDecision: boolean;
  readonly estimate: Estimate | null;
  readonly actual: Actual | null;
  /**
   * The in-product address the hover door goes to, the task's page link
   * (MP-4-12), already checked as one; absent, the door is the task's own page.
   */
  readonly page?: string;
  readonly comments: {
    readonly client: number;
    readonly mentions: number;
    readonly latest: string | null;
  };
}

/**
 * What a Projects row can do, as the page hands it in (MP-5-9): the page owns
 * the commands, the row only draws the controls. A control whose callback is
 * absent is not drawn.
 */
export interface RowActions {
  /** The tick: `true` completes, `false` reopens, through the one completion transition. */
  readonly onTick?: (row: ProjectRow, done: boolean) => void;
  /** A rename in place, already trimmed, changed and not blank. */
  readonly onRename?: (row: ProjectRow, title: string) => void;
  /** Open the task beside the board (a plain click, after the double-click window). */
  readonly onOpen?: (row: ProjectRow) => void;
  /** Open the task beside the board on its conversation: the comment badge's door (P-36). */
  readonly onOpenComments?: (row: ProjectRow) => void;
  /**
   * The row whose task is open beside the board and the door it was opened
   * by: that one element carries `data-panel-door`, so closing the panel
   * returns focus to it and not to another row's.
   */
  readonly opened?: { readonly id: string; readonly door: 'open' | 'reply' };
  /** The hover box's timer; drawn only when the page can start one. */
  readonly onStartTimer?: (row: ProjectRow) => void;
  /** The people the assignee editor offers (MP-5-10); none, no assignee editor. */
  readonly people?: readonly PersonOption[];
  /** The assignee chosen in place: a person's id, or null to leave it unassigned. */
  readonly onAssign?: (row: ProjectRow, person: string | null) => void;
  /** The due date chosen in place, as a calendar day (`YYYY-MM-DD`), or null to clear it. */
  readonly onDue?: (row: ProjectRow, due: string | null) => void;
  /** The stage chosen in place. */
  readonly onStage?: (row: ProjectRow, stage: string) => void;
  /** The estimates the estimate editor offers, in minutes (MP-4-8's choices); none, no estimate editor. */
  readonly estimates?: readonly number[];
  /** The estimate chosen in place, in whole minutes, or null to clear it. */
  readonly onEstimate?: (row: ProjectRow, minutes: number | null) => void;
}

/** One person the assignee editor offers. */
export interface PersonOption {
  readonly id: string;
  readonly name: string;
}
