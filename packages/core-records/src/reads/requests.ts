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
//
// What a read *has* gained is the commands' D06 refusal. A payload naming a
// fact the server owns -- `actor_id`, `business_id`, `updated_at` and the rest
// of `prepare.ts`'s `SYSTEM_OWNED_FIELDS` -- used to be ignored here and is
// now `FIELD_NOT_WRITABLE`, naming the keys. Ignoring it was the answer the
// accepted ledger rules out: a client that believed it had set `actor_id` got
// a `200` and no correction, so the bug lived in the client.

import type { PresetField, PresetPlan } from '../records/preset-plan.ts';
import type { ProposalView } from './proposals.ts';
import type { QueuedWork } from './queue.ts';
import type { SettingView } from './settings.ts';
import type { Capability } from './capabilities.ts';

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

/**
 * What a reader outside the business is shown of one task (minimum contract
 * 8.1 R4, 8.2 case 7): its identifier, the task fields the catalogue marks
 * `shared`, and the client comments in their shared fields. Nothing else is
 * on it, so there is no internal field to hide: history, proposals, the
 * revision and every unclassified field are absent from the body, not blanked.
 */
export interface SharedTaskView {
  readonly id: string;
  /**
   * Keyed by field key: every task field the catalogue classifies `shared`,
   * which on the shipped task spine includes `title` and `state` (the state's
   * label, I09). Empty when the catalogue classifies none.
   */
  readonly fields: Readonly<Record<string, unknown>>;
  readonly comments: readonly CommentView[];
}

/**
 * What each read takes, once its catalogue row has checked the body
 * (`ReadRow.parse` in `reads/catalogue.ts`). A row's lookups, authority and
 * serving are typed on these and never on the wire body, so a field a read
 * uses is a field its `parse` checked.
 */
export interface ReadOperands {
  readonly 'task.read': { readonly recordId: string };
  /** `null` is the business's unboarded tasks, which is where a created task starts. */
  readonly 'task.board': { readonly board: string | null };
  readonly 'person.list': NoOperands;
  /** Approved, held and unpicked. A projection; reading it claims nothing. */
  readonly 'task.queue': NoOperands;
  /**
   * What a preset would do to this business's model, computed without doing
   * any of it. It is a read because it writes nothing — including on success,
   * which is D05's whole claim — and it asks for `manage` on presets rather
   * than `read` on a collection, which is why the declaration carries its own
   * action.
   */
  readonly 'preset.plan': {
    readonly recordTypeKey: string;
    readonly presetKey: string;
    /**
     * The planner's own field type, so the read hands it on without a cast.
     * Each one is checked only as an object; the planner refuses bad keys.
     */
    readonly fields: readonly PresetField[];
  };
  /**
   * The business's own settings. It takes `read` on `settings` while the two
   * settings commands take `manage`, which is the asymmetry the model wants:
   * a setting is a business fact every member works against, and deciding who
   * must agree before money moves is not.
   *
   * Each setting carries the revision 0020 added, which is what a settings
   * write sends back as `expectedRevision`. See `reads/settings.ts`.
   */
  readonly 'settings.read': NoOperands;
  /**
   * What the caller may do here. The one read whose answer is about the caller
   * rather than about the business, and the one that takes no grant: every
   * pair it returns is a pair the caller already holds.
   */
  readonly 'session.capabilities': NoOperands;
}

/** A read about the business as a whole, which takes nothing. */
export type NoOperands = Readonly<Record<never, never>>;

/**
 * A read as the boundary hands it over: the name from the route and the body
 * as the caller sent it, unchecked. The catalogue row's `parse` is what turns
 * it into `ReadOperands`, or refuses it.
 */
export interface ReadRequest {
  readonly read: keyof ReadOperands;
  readonly [field: string]: unknown;
}

export type ReadResult =
  | { readonly ok: true; readonly task: TaskDetail }
  /**
   * `task.read` for a reader outside the business. Its own key rather than a
   * second shape under `task`, so a client that reads `task` can never be
   * handed the narrower view and render its missing fields as empty.
   */
  | { readonly ok: true; readonly sharedTask: SharedTaskView }
  | { readonly ok: true; readonly tasks: readonly TaskSummary[] }
  | { readonly ok: true; readonly persons: readonly PersonView[] }
  | { readonly ok: true; readonly queue: readonly QueuedWork[] }
  | { readonly ok: true; readonly plan: PresetPlan }
  | { readonly ok: true; readonly settings: readonly SettingView[] }
  /**
   * The capability answer is flat: `personId`, `businessKey` and `grants` sit
   * beside `ok` rather than under a `capabilities` object, because that is the
   * shape the surfaces read and one nesting level for three fields buys
   * nothing.
   */
  | {
      readonly ok: true;
      readonly personId: string;
      readonly businessKey: string;
      readonly grants: readonly Capability[];
    };
