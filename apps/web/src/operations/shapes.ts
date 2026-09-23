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
  /**
   * Null is a real answer. A task written before the server placed a created
   * task in a state carries no state link, and the screens draw that rather
   * than dereferencing it.
   */
  readonly state: TaskState | null;
  readonly assignee: TaskPerson | null;
  readonly due: string | null;
  readonly priority: number | null;
  readonly completedAt: string | null;
  readonly revision: number;
}

/**
 * One comment as `task.read` carries it.
 *
 * The keys are the server's spelling, not this file's: `comment_type` and
 * `posted_at` arrive snake_cased because they are the comment record's own
 * field names, and the external projection is an allowlist over those same
 * names (`docs/local/AUTHORITY.md`). Renaming them here would mean a projection
 * that drops a field arrives as `undefined` under a name the server never
 * used, and the screen would have to guess which of the two it was looking at.
 *
 * **Every field is optional except the identifier**, because an external reader
 * is given fewer of them. The screen draws what arrived and says nothing about
 * what did not; it does not fill a gap in a projection with a word of its own.
 */
export interface TaskComment {
  readonly id: string;
  readonly audience?: string;
  readonly author?: string;
  readonly body?: string;
  readonly comment_type?: string;
  readonly posted_at?: string;
  readonly edited_at?: string | null;
  readonly source?: string;
}

export interface TaskDetail extends TaskSummary {
  readonly description: string | null;
  readonly history: readonly TaskHistoryEntry[];
  /**
   * In posted order, as the read returned them. An internal reader is given
   * every comment in full; every other role is given the client comments in
   * the fields the catalogue marks `shared`.
   */
  readonly comments: readonly TaskComment[];
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
