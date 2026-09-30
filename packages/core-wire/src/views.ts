// SPDX-License-Identifier: AGPL-3.0-only
//
// What the reads answer, as it crosses the wire: the one declaration of each
// read result, for the server and for every client.
//
// This module holds types only and imports types only, so the web and the
// command line take it through the wire package's index with no database code
// anywhere behind it. A client that kept its own copy of
// these could drift from what the server sends without a typecheck noticing,
// which is how the web came to believe every task has a title.
//
// Each time here is an ISO string, because that is what arrives: the reads
// convert their own `Date`s so the type the server builds is the type a
// client parses.

import type { Action, PresetPlan, SettingValueType } from '../../core-records/src/index.ts';

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
  /** `person`, `agent` or `worker` (MP-4-16); null for an actor this business does not hold. */
  readonly actorKind: string | null;
  /** The person's display name for a person's actor; null for any other. */
  readonly actorName: string | null;
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
 * comments in the fields the catalogue marks `shared`, built by
 * `externalCommentProjection`. The type is `unknown`-valued rather than a
 * fixed record because the external half is catalogue-driven — pinning the
 * keys here would put a second copy of the allowlist in the type, and the
 * whole point of I09 is that classifying a field is the only way to expose it.
 */
export type CommentView = Readonly<Record<string, unknown>>;

export interface TaskDetail extends TaskSummary {
  readonly description: string | null;
  /** The pre-prompt an agent boots on for this task (MP-4-7); null when none is written. */
  readonly agentBrief: string | null;
  /** The in-product address this task is about, path and hash (MP-4-12); null when unlinked. */
  readonly pageLink: string | null;
  /** The time the burn bar measures against, whole minutes (MP-4-8); null when not set. */
  readonly estimateMinutes: number | null;
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
  /**
   * The currency of the cap an approval on this task would draw on: the open
   * envelope's cap, or the business's cap before there is one. A proposal in
   * any other currency is refused `CAP_BINDING_MISMATCH` at the decision, so
   * the propose form offers this one and no list of its own. Null when the
   * business has no cap. It is read inside the task read, so a reader who may
   * not read the task is told nothing about the cap.
   */
  readonly capCurrency: string | null;
  /** The task's open envelope, which a top-up raises (T2e); null when none is open. */
  readonly envelope: TaskEnvelope | null;
  /** The task's alerts, newest first (T2h). The detail is the team's, and so are they. */
  readonly alerts: readonly TaskAlert[];
  /** The derived rank and its calc line (R70, MP-4-9). Worked out at read, never stored. */
  readonly rank: RankView;
  /** The Ad hoc mark (MP-4-10, CS-4.9): billing reads it, and new time entries default to it. */
  readonly adHoc: boolean;
  /**
   * Client access (MP-4-10, CS-4.10, R45): true exactly when the task is
   * shared with at least one of its client's people. The tick draws this and
   * nothing stored beside it.
   */
  readonly clientAccess: boolean;
  /**
   * The board the task sits on, as its page's crumb reads it (MP-4-1): null
   * when it sits on none. A board is a task, so its title is sent only to a
   * reader who may read that board; anyone else is told there is one.
   */
  readonly board: BoardCrumb | null;
  /** The task's stage as stored (`task.set_stage`), or null when it has none. */
  readonly stage: string | null;
  /**
   * Whether the task is put under a client (`task.set_party`). The facts band
   * says so; the client's name waits on the client model.
   */
  readonly clientSet: boolean;
  /**
   * The task's subtasks (MP-4-4, CS-15.19), in their order: each a full task
   * whose `parent` is this one, and only those the reader may read.
   */
  readonly steps: readonly StepView[];
  /**
   * Time on this task (MP-4-6): the reader's own entries and running timer,
   * and the task's total. Null for an agent, which is sent no one's time.
   */
  readonly time: TaskTimeView | null;
}

/**
 * A task's time as one person reads it (MP-4-6, RS-VAULT-9: a person sees
 * their own time, never a leaderboard). `entries` are the reader's own, newest
 * first; `totalMinutes` is every person's finished minutes on the task, one
 * number with no names, which the burn bar reads against the estimate.
 */
export interface TaskTimeView {
  readonly entries: readonly TimeEntryView[];
  readonly running: { readonly entryId: string; readonly startedAt: string } | null;
  readonly totalMinutes: number;
}

/** One of the reader's own time entries. `minutes` is null while it runs. */
export interface TimeEntryView {
  readonly id: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly minutes: number | null;
  readonly note: string;
  readonly adHoc: boolean;
  readonly source: 'timer' | 'log';
}

/**
 * One subtask as its parent's page lists it (MP-4-4). `done` is the completed
 * category; `archived` says when and why a step left the count without being
 * done (MP-4-15), and is null for a live one.
 */
export interface StepView {
  readonly id: string;
  readonly key: string;
  readonly title: string | null;
  readonly state: TaskStateView | null;
  readonly done: boolean;
  readonly archived: { readonly at: string; readonly why: string } | null;
  readonly assignee: PersonView | null;
  readonly revision: number;
}

/** One alert as `task.read` and `task.queue` carry it (`core-runtime/src/alerts.ts`). */
export interface TaskAlert {
  readonly id: string;
  readonly taskId: string;
  readonly kind: string;
  readonly waitingReason: string | null;
  readonly causeId: string;
  readonly raisedAt: string;
}

/** An open envelope as the task read carries it (T2e). */
export interface TaskEnvelope {
  readonly id: string;
  readonly capId: string;
  readonly currency: string;
  readonly maximumMinor: number;
  readonly heldMinor: number;
  readonly actualMinor: number;
}

/** A task's board as the crumb draws it: its title, or that it is withheld. */
export type BoardCrumb =
  { readonly readable: true; readonly title: string | null } | { readonly readable: false };

/**
 * A task's derived rank as its reader is shown it (R70, MP-4-9).
 *
 * `number` is the task's place among the open tasks this reader may read, or
 * null when the task is not ranked; `score` is null exactly then. `calc` is the
 * line drawn under the rank, worked out on the server so every surface shows the
 * same words, and it names nothing but this task's own marks and modifiers.
 */
export interface RankView {
  readonly number: number | null;
  readonly score: number | null;
  readonly calc: string;
}

/**
 * What a reader outside the business is shown of one task (minimum contract
 * 8.1 R4, 8.2 case 7): its identifier, the task fields the catalogue marks
 * `shared`, the client comments in their shared fields, and the record's
 * revision. Nothing else is on it, so there is no internal field to hide:
 * history, proposals and every unclassified field are absent from the body,
 * not blanked.
 */
export interface SharedTaskView {
  readonly id: string;
  /**
   * The record's version, which `task.comment` requires as
   * `expectedRevision`. An external party with a provisioned `comment` grant
   * may write a client comment (AUTHORITY.md R4), and without this nothing it
   * can read carries the revision the write needs. It is the record's
   * version, not a field value.
   */
  readonly revision: number;
  /**
   * Keyed by field key: every task field the catalogue classifies `shared`,
   * which on the shipped task spine includes `title` and `state` (the state's
   * label, I09). Empty when the catalogue classifies none.
   */
  readonly fields: Readonly<Record<string, unknown>>;
  readonly comments: readonly CommentView[];
}

/**
 * One comment as an internal reader's detail carries it: every field, always
 * (`commentsFor` in `core-commands/src/reads/tasks.ts`). The keys are the comment record's own
 * field names, which is why they are snake_cased. A type alias rather than an
 * interface, so it is also a `CommentView`.
 */
export type InternalCommentView = {
  readonly id: string;
  readonly audience: string;
  readonly author: string;
  readonly body: string;
  readonly comment_type: string;
  readonly posted_at: string;
  readonly edited_at: string | null;
  readonly source: string;
  /** The top-level message this replies to, or null for a message (R42). */
  readonly parent: string | null;
  /**
   * Where a top-level client message stands (DT-19): `owed` (the client's,
   * awaiting the team), `not_acknowledged` (the team's, awaiting the client)
   * or `answered`; null on an internal note and on a reply.
   */
  readonly signal: 'answered' | 'owed' | 'not_acknowledged' | null;
  /**
   * Whether the reader's own actor wrote it, so a screen draws the edit and
   * delete controls on those rows only (CS-4.34). The commands check the
   * author again; this only saves offering a control that would be refused.
   */
  readonly own: boolean;
};

export interface EvidenceView {
  readonly id: string;
  readonly renderer: string;
  readonly digest: string;
  readonly body: unknown;
}

export interface DecisionLink {
  readonly id: string;
  readonly seq: number;
  readonly decision: string;
  readonly round: number;
  readonly decidedByPersonId: string;
  readonly decidedAt: string;
  readonly signingKeyId: string;
  readonly signature: string;
  readonly prevHash: string;
  readonly hash: string;
  /**
   * Which fields the link covers (`signing.ts`, `LinkVersion`). A `1` is a
   * decision written before the link covered its round, time, lineage, acting
   * actor, evidence digest and key id: it verifies, and those fields on it are
   * not covered by the chain. A `3` is a decision whose signed payload also
   * carries those fields and its place in the chain (`signedFields`).
   */
  readonly linkVersion: number;
  /**
   * The fields of this item the decision's signature covers, in this item's
   * names. The read has already checked each of them against the signed
   * payload. A field shown and not listed is covered only by the unkeyed
   * chain link, which a writer who recomputes every later link can change: on
   * a v1 or v2 decision that is its round, time and place in the chain. The
   * signature and hash are the proof itself and are never listed.
   */
  readonly signedFields: readonly string[];
}

export interface ReservationView {
  readonly id: string;
  readonly state: string;
  readonly heldMinor: number;
  readonly actualMinor: number | null;
  /** What settling at the observed cost gave back to the cap (T2d); `null` until settled. */
  readonly releasedMinor: number | null;
  readonly classifiedCause: string | null;
  readonly leaseId: string | null;
  readonly lease: LeaseView | null;
  readonly attempt: AttemptView | null;
}

export interface LeaseView {
  readonly id: string;
  readonly fence: number;
  readonly state: string;
  readonly expiresAt: string;
  readonly holderActorId: string | null;
}

export interface AttemptView {
  readonly id: string;
  readonly state: string;
  readonly dispatchMarker: boolean;
  readonly observed: boolean;
  /** Why the work dropped under it (T3e1), or null: never a person's cancellation. */
  readonly dropCause: string | null;
}

export interface GateView {
  readonly id: string;
  /**
   * The stored state, except that a stored `pending` at or past `expiresAt`
   * reads `expired`. See the head of this file.
   */
  readonly state: string;
  readonly round: number;
  readonly expiresAt: string;
  /**
   * The server's own answer, so a client with a skewed clock cannot disagree.
   * True only for an otherwise pending gate: a decided gate is not expired.
   */
  readonly expired: boolean;
  readonly payloadDigest: string;
}

export interface ProposalVersionView {
  readonly versionId: string;
  readonly version: number;
  readonly purpose: string;
  readonly maximumMinor: number;
  readonly currency: string;
  readonly payloadDigest: string;
  readonly payload: unknown;
  readonly supersededAt: string | null;
  readonly runId: string | null;
  readonly evidence: EvidenceView | null;
  readonly gate: GateView | null;
}

export interface ProposalView {
  readonly lineageId: string;
  readonly state: string;
  /** Newest first, so the live version is the head of the list. */
  readonly versions: readonly ProposalVersionView[];
  readonly decisions: readonly DecisionLink[];
  readonly reservations: readonly ReservationView[];
}

export interface QueuedWork {
  readonly reservationId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly versionId: string;
  readonly lineageId: string;
  readonly purpose: string;
  readonly heldMinor: number;
}

/**
 * One setting, projected.
 *
 * `updatedAt` is an ISO string rather than a `Date` because every other time
 * on this surface is (`TaskSummary.due`, `HistoryEntry.at`): one read handing
 * back a `Date` and the next a string is the difference a client discovers in
 * production.
 */
export interface SettingView {
  readonly key: string;
  readonly value: number | boolean | string | null;
  /** `numeric`, `boolean` or `text`, as the row declares it. */
  readonly valueType: SettingValueType;
  readonly updatedAt: string;
  /** Null until a command has written it. Nobody owns a shipped default. */
  readonly updatedByActorId: string | null;
  /**
   * What a write names to say which value it is replacing. Starts at 1, and a
   * command that sends a number the row has moved past is refused
   * `VERSION_STALE` rather than having its value merged over the winner's.
   */
  readonly revision: number;
}

/** One thing the caller may do, as the grant model spells it. */
export interface Capability {
  readonly collection: string;
  readonly action: Action;
}

/**
 * The person answer, flattened onto the read result rather than nested.
 *
 * The three fields sit beside `ok` on the wire -- `{ ok: true, personId,
 * businessKey, grants }` -- because that is the shape the surfaces are being
 * written against, and a nested `capabilities` object would have made every
 * client reach through one more level for three fields.
 */
export interface SessionCapabilities {
  readonly personId: string;
  /** The business's key, which is what a path and a screen both name it by. */
  readonly businessKey: string;
  /** Distinct pairs, sorted. A pair held at two scopes appears once. */
  readonly grants: readonly Capability[];
}

/**
 * `task.read` for a reader inside the business. The person prefix builds the
 * detail with every comment in full, so its comments are the internal shape;
 * an agent's detail carries the shared projection instead and stays a
 * `TaskDetail`.
 */
export interface InternalTaskDetail extends TaskDetail {
  readonly comments: readonly InternalCommentView[];
}

/** `task.read` on the person prefix: the whole detail, for a reader inside the business. */
export interface InternalTaskRead {
  readonly ok: true;
  readonly task: InternalTaskDetail;
}

/**
 * `task.read` for a reader outside the business. Its own key rather than a
 * second shape under `task`, so a client that reads `task` can never be
 * handed the narrower view and render its missing fields as empty.
 */
export interface SharedTaskRead {
  readonly ok: true;
  readonly sharedTask: SharedTaskView;
}

/** Which of the two arrived is decided by the key, never by the reader's role. */
export type TaskReadResult = InternalTaskRead | SharedTaskRead;

/**
 * One row of a board (MP-5-8): the summary and what the Projects board's
 * cells draw from stored records, each the value `task.read` answers for the
 * same task. The rank is worked out at read in the reader's own pool.
 */
export interface BoardTask extends TaskSummary {
  readonly rank: RankView;
  /** The stage as `task.set_stage` stored it; null for none. */
  readonly stage: string | null;
  /** True when the task is put under a client (`task.set_party`). */
  readonly clientSet: boolean;
  /**
   * Every finished minute logged on the task (MP-4-6), the total `task.read`'s
   * time answers: one number, no names. Derived at read; 0 for none.
   */
  readonly actualMinutes: number;
  /**
   * Where the task's state stands in the workflow (MP-5-11): the state
   * record's `position`, read with the state, so the board groups in the
   * workflow's order. Null when the task has no state.
   */
  readonly statePosition: number | null;
  /**
   * Why the task waits (MP-5-11), from the run lifecycle: `needs_approval`
   * while a gate on its live version is pending and not expired, whoever may
   * decide it. Null when nothing the board reads holds it.
   */
  readonly waitReason: 'needs_approval' | null;
  /**
   * True when the task waits at an open gate for the caller's decision
   * (MP-5-12): a pending gate, not expired, on its live version, inside the
   * caller's decide grant. The Review mode's rows and its live count.
   */
  readonly awaitingDecision: boolean;
}

export interface TaskBoardResult {
  readonly ok: true;
  /** The board's tasks the caller's grants reach. */
  readonly tasks: readonly BoardTask[];
  /**
   * How many of this board's tasks in the caller's business their grants do
   * not reach: a count, never which (B-22). Only for a member holding
   * task:read on the whole collection; absent for a member reading through
   * record grants, a client login under owner answer 22.
   */
  readonly withheld?: number;
  /** When the newest task served last changed (MP-5-7); null when none is served. */
  readonly changedAt: string | null;
  /** The caller's own person id, which the viewer preset narrows to (MP-5-12). */
  readonly viewer: string;
}

export interface PersonListResult {
  readonly ok: true;
  readonly persons: readonly PersonView[];
}

/**
 * `task.queue`'s answer. An empty queue is `[]` beside `ok`, never a refusal.
 * `alerts` are the team's (T2h), and so are `outages` (T3e2); a reader outside
 * the team is sent none.
 */
export interface QueueResult {
  readonly ok: true;
  readonly queue: readonly QueuedWork[];
  readonly alerts: readonly TaskAlert[];
  readonly outages: readonly OutageView[];
}

/** One outage's report, as `task.queue` carries it to the team (T3e2; `core-runtime/src/recovery/outage.ts`). */
export interface OutageView {
  readonly id: string;
  readonly cause: string;
  /** Whose fault the cause names: the provider's, the network's, or ours. */
  readonly fault: string;
  readonly openedAt: string;
  readonly lastDropAt: string;
  /** Null while drops of its cause may still join it. */
  readonly closedAt: string | null;
  readonly runs: readonly {
    readonly taskId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly reactivated: boolean;
  }[];
}

/** `preset.plan`'s answer: a dry-run plan that installs and approves nothing. */
export interface PresetPlanResult {
  readonly ok: true;
  readonly plan: PresetPlan;
}

export interface SettingsReadResult {
  readonly ok: true;
  readonly settings: readonly SettingView[];
}

/**
 * The capability answer is flat: `personId`, `businessKey` and `grants` sit
 * beside `ok` rather than under a `capabilities` object, because that is the
 * shape the surfaces read and one nesting level for three fields buys
 * nothing.
 */
export interface CapabilitiesResult extends SessionCapabilities {
  readonly ok: true;
}

/** One run naming the task, as `task.execution` reports it (T2a); never merged. */
export interface ExecutionRun {
  readonly runId: string;
  readonly lineageId: string;
  readonly versionId: string;
  readonly state: string;
  readonly taskRevisionAtRequest: number | null;
  readonly createdAt: string;
}

/** One durable progress event, in the task-wide order. */
export interface ExecutionEvent {
  readonly eventId: string;
  readonly runId: string;
  readonly position: number;
  readonly kind: string;
  /** The attempt the event is about; its receipt is read by this. */
  readonly attemptId: string;
  readonly at: string;
}

/** `task.execution`'s answer, under `execution`; `denied`, `unavailable` and `loading` are the read's own. */
export interface TaskExecutionResult {
  readonly execution: TaskExecution;
}

export interface TaskExecution {
  readonly outcome: 'ready' | 'no-run' | 'stale';
  readonly runs: readonly ExecutionRun[];
  readonly events: readonly ExecutionEvent[];
  /** Whether `events` reaches the task's last recorded event. */
  readonly complete: boolean;
  /** The cursor for the rest, or null when nothing was left out. */
  readonly next: number | null;
}

/** `task.receipt`: what an observed effect came from, and what it cost (T2c2, T2d). */
export interface ReceiptResult {
  readonly receipt: {
    readonly attemptId: string;
    readonly decision: { readonly id: string };
    readonly version: { readonly id: string; readonly number: number };
    readonly effect: { readonly kind: string; readonly audience: string };
    readonly settlement:
      | {
          readonly state: 'settled';
          readonly heldMinor: number;
          readonly spentMinor: number;
          readonly releasedMinor: number;
        }
      | { readonly state: string; readonly heldMinor: number };
  };
}
