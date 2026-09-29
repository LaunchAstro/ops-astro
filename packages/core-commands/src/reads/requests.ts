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
// of `prepare.ts`'s `SYSTEM_OWNED_FIELDS` -- is `FIELD_NOT_WRITABLE`, naming
// the keys. Ignoring it is the answer the accepted ledger rules out: a client
// that believed it had set `actor_id` would get a `200` and no correction, so
// the bug would live in the client.

import type { PresetField } from '../../../core-records/src/index.ts';
import type {
  CapabilitiesResult,
  PersonListResult,
  PresetPlanResult,
  QueueResult,
  SettingsReadResult,
  SharedTaskRead,
  TaskBoardResult,
  TaskDetail,
  TaskLedgerResult,
} from '../../../core-wire/src/index.ts';
import type { TaskExecution } from './execution.ts';
import type { Receipt } from '../../../core-runtime/src/index.ts';

// The result types live in `views.ts`, which the clients import; the server's
// own modules keep importing them from here.
export type {
  CommentView,
  HistoryEntry,
  PersonView,
  SharedTaskView,
  TaskDetail,
  TaskStateView,
  TaskSummary,
} from '../../../core-wire/src/index.ts';

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
  /**
   * The activity ledger's page: the newest days with events before `before`
   * (a `YYYY-MM-DD` in `timeZone`), or the newest days of all when it is
   * null. The zone is the reader's, and it is what a day means: an event at
   * 23:30 in Townsville is on a different day than it is in UTC.
   */
  readonly 'task.ledger': { readonly before: string | null; readonly timeZone: string };
  readonly 'person.list': NoOperands;
  /** Approved, held and unpicked. A projection; reading it claims nothing. */
  readonly 'task.queue': NoOperands;
  /**
   * The task's runs and their progress events after `cursor`, a position the
   * caller already holds (0 for the start). See `reads/execution.ts`.
   */
  readonly 'task.execution': { readonly recordId: string; readonly cursor: number };
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
  /** What an observed effect came from, asked on its attempt (T2c2). */
  readonly 'task.receipt': { readonly attemptId: string };
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
  | SharedTaskRead
  | TaskBoardResult
  | TaskLedgerResult
  | PersonListResult
  | QueueResult
  | PresetPlanResult
  | SettingsReadResult
  | { readonly ok: true; readonly execution: TaskExecution }
  | { readonly ok: true; readonly receipt: Receipt }
  | CapabilitiesResult;
