// SPDX-License-Identifier: AGPL-3.0-only
//
// Common task identity and list contracts, shared by task detail and board views,
// and the open run a task's agent shows.

/** The task state a task points at. The machine category is what a board groups on. */
export interface TaskStateView {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly machineCategory: string;
}

export interface PersonView {
  readonly personId: string;
  readonly name: string;
}

/** A task in a list. Everything the detail has except the long text and the history. */
export interface TaskSummary {
  readonly id: string;
  readonly key: string;
  readonly title: string | null;
  readonly state: TaskStateView | null;
  readonly assignee: PersonView | null;
  readonly due: string | null;
  readonly priority: number | null;
  readonly completedAt: string | null;
  /** R70 task start date; absent on older clients, null when never started. */
  readonly startedAt?: string | null;
  readonly revision: number;
}

/** An open run: `waiting` for a runner, `unanswered` once none took it in its bound (#1710). */
export interface TaskRunView {
  readonly state: 'waiting' | 'unanswered' | 'started';
  readonly launchedAt: string;
  /**
   * How long a `waiting` run's bound had left when the server answered, by
   * the server's clock; 0 for any other state. A client counts it from when
   * the answer arrived, never from `launchedAt` against its own clock.
   */
  readonly boundLeftMs: number;
}
