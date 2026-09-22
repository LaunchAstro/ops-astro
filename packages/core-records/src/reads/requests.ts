// SPDX-License-Identifier: AGPL-3.0-only
//
// What a caller sends to read, and what comes back.
//
// A read is not a small write. It carries no `operation_id`, because there is
// nothing to replay, and no `expected_revision`, because there is nothing to be
// stale against. Giving it either would have made the envelope's two strongest
// rules -- every mutation is identified, every write names the revision it is
// writing against -- into things some operations have and some do not, which is
// how a rule becomes a convention.
//
// What a read does share with a write is everything about who is asking: the
// business comes from the path and is verified server-side, the actor from the
// resolved login, and the grant check is the same `checkAuthority` the commands
// use. A denied read says `SCOPE_NOT_GRANTED`; it never comes back as an empty
// list, because empty and denied are different answers.

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

export interface HistoryEntry {
  readonly at: string;
  readonly actorId: string;
  readonly operation: string;
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
  readonly revision: number;
}

export interface TaskDetail extends TaskSummary {
  readonly description: string | null;
  readonly history: readonly HistoryEntry[];
}

export type ReadRequest =
  | { readonly read: 'task.read'; readonly recordId: string }
  /** `null` is the business's unboarded tasks, which is where a created task starts. */
  | { readonly read: 'task.board'; readonly board: string | null }
  | { readonly read: 'person.list' };

export type ReadResult =
  | { readonly ok: true; readonly task: TaskDetail }
  | { readonly ok: true; readonly tasks: readonly TaskSummary[] }
  | { readonly ok: true; readonly persons: readonly PersonView[] };
