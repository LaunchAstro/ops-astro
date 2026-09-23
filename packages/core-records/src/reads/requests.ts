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
//
// A read does write an audit event. See `dispatch.ts`.

import type { PresetPlan } from '../records/preset-plan.ts';
import type { ProposalView } from './proposals.ts';
import type { QueuedWork } from './queue.ts';

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

/**
 * One comment as a reader is shown it.
 *
 * The shape is the same for both audiences and the *contents* are not: an
 * internal reader gets every comment in full, an external one gets the client
 * comments in the fields the catalogue marks `shared`, built by L2's
 * `externalCommentProjection`. The type is `unknown`-valued rather than a
 * fixed record because the external half is catalogue-driven — pinning the
 * keys here would put a second copy of the allowlist in the type, and the
 * whole point of I09 is that classifying a field is the only way to expose it.
 */
export type CommentView = Readonly<Record<string, unknown>>;

export interface TaskDetail extends TaskSummary {
  readonly description: string | null;
  readonly history: readonly HistoryEntry[];
  /** Oldest first. Empty is a real answer; a denied read never reaches here. */
  readonly comments: readonly CommentView[];
  /**
   * Every proposal on this task, newest lineage first, with its stored version,
   * digest, evidence pack, gate state and expiry, its decision chain and the
   * reservation, lease and attempt an approval produced.
   *
   * It is on the detail rather than behind a read of its own because a task
   * page that showed the evidence and then had to fetch the version separately
   * could offer a decision on a version it never displayed, and the exact
   * version is the whole of what `decide` compares. One read, one answer, one
   * `versionId` for the button to carry. See `reads/proposals.ts` and the
   * "Proposal projection" heading in `docs/local/API.md`.
   */
  readonly proposals: readonly ProposalView[];
}

/** One field as a preset ships it, on the wire. Validated by L2's planner. */
export interface PresetFieldRequest {
  readonly key: string;
  readonly label: string;
  readonly valueType: string;
  readonly writeMode?: string;
  readonly owningOperations?: readonly string[];
  readonly visibilityClass?: string;
  readonly searchable?: boolean;
  readonly uniqueValue?: boolean;
}

export type ReadRequest =
  | { readonly read: 'task.read'; readonly recordId: string }
  /** `null` is the business's unboarded tasks, which is where a created task starts. */
  | { readonly read: 'task.board'; readonly board: string | null }
  | { readonly read: 'person.list' }
  /** Approved, held and unpicked. A projection; reading it claims nothing. */
  | { readonly read: 'task.queue' }
  /**
   * What a preset would do to this business's model, computed without doing
   * any of it. It is a read because it writes nothing — including on success,
   * which is D05's whole claim — and it asks for `manage` on presets rather
   * than `read` on a collection, which is why the declaration carries its own
   * action.
   */
  | {
      readonly read: 'preset.plan';
      readonly recordTypeKey: string;
      readonly presetKey: string;
      readonly fields: readonly PresetFieldRequest[];
    };

export type ReadResult =
  | { readonly ok: true; readonly task: TaskDetail }
  | { readonly ok: true; readonly tasks: readonly TaskSummary[] }
  | { readonly ok: true; readonly persons: readonly PersonView[] }
  | { readonly ok: true; readonly queue: readonly QueuedWork[] }
  | { readonly ok: true; readonly plan: PresetPlan };
