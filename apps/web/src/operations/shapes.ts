// SPDX-License-Identifier: AGPL-3.0-only
//
// What the three reads return, as the slice contract declares them.
//
// These are wire shapes and they live beside the client for the same reason
// the refusal does: they describe JSON that crossed a network. The server's own
// types are the server's; agreeing with them is what the integrated proof is
// for, and asserting it here with an import would only move the assumption.

export interface TaskState {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly machineCategory: string;
}

export interface TaskPerson {
  readonly personId: string;
  readonly name: string;
}

export interface TaskHistoryEntry {
  readonly at: string;
  readonly actorId: string;
  readonly operation: string;
}

export interface TaskSummary {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly state: TaskState;
  readonly assignee: TaskPerson | null;
  readonly due: string | null;
  readonly priority: number | null;
  readonly completedAt: string | null;
  readonly revision: number;
}

export interface TaskDetail extends TaskSummary {
  readonly description: string | null;
  readonly history: readonly TaskHistoryEntry[];
}

export interface TaskReadResult {
  readonly ok: true;
  readonly task: TaskDetail;
}

export interface TaskBoardResult {
  readonly ok: true;
  readonly tasks: readonly TaskSummary[];
}

export interface PersonListResult {
  readonly ok: true;
  readonly persons: readonly TaskPerson[];
}
