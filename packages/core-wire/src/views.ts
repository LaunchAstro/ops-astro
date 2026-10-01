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

import type {
  Action,
  DeliveryState,
  InboxAccess,
  InboxAlert,
  InboxFactKind,
  InboxReason,
  InboxWorkState,
  PresetPlan,
  SettingValueType,
} from '../../core-records/src/index.ts';

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
  /**
   * The person the actor is; null for an agent or a worker, and for a reader
   * not shown people (the agent prefix).
   */
  readonly personId: string | null;
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
  /**
   * The client the task is for: the record's `client` slot, null on an
   * internal task. A reader of the task already reaches its client, so this
   * widens nothing; the Agent pane asks the drawer with it, so the egress rule
   * sees whose data a plan would carry (AW-04).
   */
  readonly clientId: string | null;
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
  /**
   * The task's token ledger (MP-6-5): each envelope's allowance, what it was
   * built from, and what is held and spent against it. The per-run rows are the
   * proposals' reservations, each naming its envelope. Read inside the task
   * read, so a reader who may not read the task is told nothing of it. Null
   * for an agent: it names the business's cap, which a delegate on one task is
   * not shown (I09).
   */
  readonly ledger: TaskLedgerView | null;
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

export interface TaskLedgerView {
  /** Open one first, then the closed ones, newest first. Empty before any approval. */
  readonly envelopes: readonly EnvelopeView[];
  /** AW-05's stops on the task's runs, by run, oldest ask first. Empty before any stop. */
  readonly stops: readonly BudgetStopView[];
  /** MP-6-2's state revision lists: each kept version of the task's runs, newest first. */
  readonly states: readonly RunStateView[];
}

/** One kept version of a run's state (MP-6-2, CS-16.4): the writer's text, shown as text. */
export interface RunStateView {
  readonly runId: string;
  readonly version: number;
  readonly knowledge: readonly string[];
  readonly unknowns: readonly string[];
  /** The person, or the agent inside its delegation, who revised it. */
  readonly revisedBy: { readonly actorId: string };
  readonly revisedAt: string;
}

/** One stop at a run's approved ceiling: the ask a person answers (AW-05, MP-6-5, C54). */
export interface BudgetStopView {
  readonly askId: string;
  readonly runId: string;
  /** 1 to 3; a run asks three times at most. */
  readonly number: number;
  /** The third is the one consolidated decision. */
  readonly kind: 'stop' | 'consolidated';
  readonly ceilingMinor: number;
  /** The spend to date when it stopped. */
  readonly spentMinor: number;
  readonly currency: string;
  readonly raisedAt: string;
  /** A person's answer, or null while the ask waits. */
  readonly answer: 'top_up' | 'end' | null;
  /** A first top-up above the four-eyes band, waiting for a second person, or null. */
  readonly awaitingSecond: { readonly amountMinor: number } | null;
}

export interface EnvelopeView {
  readonly id: string;
  readonly state: 'open' | 'closed';
  /** The allowance. */
  readonly maximumMinor: number;
  readonly heldMinor: number;
  /** Spent. */
  readonly actualMinor: number;
  readonly currency: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  /** The approval whose reservation opened it: its first reservation's version. */
  readonly openedBy: { readonly versionId: string } | null;
  /** The cap it draws on. */
  readonly cap: { readonly key: string; readonly limitMinor: number; readonly currency: string };
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
  /** The task envelope it holds against (MP-6-5): the per-run rows add up to it. */
  readonly envelopeId: string;
  /** The run it holds for: one per-run row of the token panel (MP-6-5). */
  readonly runId: string;
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
  /** The run's first claim, or null before one (MP-6-2's hero time). */
  readonly startedAt: string | null;
  /** A hand-back with no claim after it, or null while the run is out or never ran. */
  readonly endedAt: string | null;
  /** The token units the run's model calls recorded, or null for none (MP-6-2's hero tokens). */
  readonly tokenUnits: number | null;
  /** What the run was given at its start (AW-02's pin slot, 0192); empty with no pin (MP-6-2). */
  readonly pins: readonly RunPinView[];
  /** Each instruction file the run read, in its order (the read ledger, 0192). */
  readonly reads: readonly RunReadView[];
  readonly evidence: EvidenceView | null;
  readonly gate: GateView | null;
  /** The checks the run performed on this version, oldest first (MP-6-1, CS-16.3). */
  readonly checks: readonly CheckView[];
}

/**
 * The run's pinned definition reference, as stored: a bootstrap file by path,
 * read at pin time, or a definition version by id. The digest and size are
 * the identity; the path is provenance only.
 */
export interface RunPinView {
  readonly kind: string;
  readonly path: string | null;
  readonly digest: string;
  readonly size: number;
  readonly readAt: string | null;
  readonly definitionVersionId: string | null;
  readonly pinnedAt: string;
}

/** One pinned read the run made, as its ledger row records it. */
export interface RunReadView {
  readonly sequence: number;
  readonly path: string;
  readonly digest: string;
  readonly size: number;
  readonly readAt: string;
  readonly isEntry: boolean;
}

/** One check a run recorded under its worker lease, against the version it ran on. */
export interface CheckView {
  readonly id: string;
  readonly name: string;
  readonly outcome: string;
  readonly note: string | null;
  /** The lease holder that performed it: the provenance is the lease, not a claim. */
  readonly performedByActorId: string;
  readonly recordedAt: string;
}

/** One grant a delegation draws on, for the link to it in the access ledger (R71). */
export interface CoveringGrantView {
  readonly id: string;
  readonly collection: string;
  readonly action: string;
  /** `business`, or `record` for a grant on this task alone. */
  readonly scopeKind: string;
}

/**
 * What a run was allowed to touch (MP-6-4, CS-6.1), set by the broker when the
 * lease was taken and read-only here: the lease's own delegation, never the
 * task's fields. A lease a person holds carries no delegation.
 */
export interface RunScopeView {
  readonly leaseId: string;
  /** When the lease was taken: the moment the run's context was pinned. */
  readonly acquiredAt: string;
  readonly delegation: {
    readonly id: string;
    readonly purpose: string;
    /** The one resource the delegation was minted for (the one-task ceiling). */
    readonly scope: { readonly kind: string; readonly id: string };
    readonly collections: readonly string[];
    readonly actions: readonly string[];
    readonly grantedAt: string;
    readonly expiresAt: string;
    /** `live`, or why it no longer is: `expired`, `revoked` or `settled`. */
    readonly state: string;
    /** The person whose live grants are its ceiling. */
    readonly delegatePersonId: string;
    /** That person's live grants it draws on now; empty when they hold none. */
    readonly grants: readonly CoveringGrantView[];
  } | null;
}

export interface ProposalView {
  readonly lineageId: string;
  readonly state: string;
  /** Newest first, so the live version is the head of the list. */
  readonly versions: readonly ProposalVersionView[];
  readonly decisions: readonly DecisionLink[];
  readonly reservations: readonly ReservationView[];
  /** The scope of each lease the lineage's runs took, oldest first (MP-6-4). */
  readonly scopes: readonly RunScopeView[];
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
  /** The signed-in person, or under an agent credential the person it acts for. */
  readonly personId: string;
  /**
   * Under an agent credential (API-2) only: the acting identity, its agent
   * actor, and then `grants` are the ticked keys the person still holds.
   */
  readonly agentActorId?: string;
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

export interface TaskBoardResult {
  readonly ok: true;
  readonly tasks: readonly TaskSummary[];
}

/**
 * One applied write to a task, as the activity ledger lists it (MP-8-4). The
 * actor is named, never identified: the ledger is read by people, and an
 * actor's identifier tells them nothing a name does not.
 */
export interface LedgerEventView {
  readonly id: string;
  readonly at: string;
  /** The person who acted, or what kind of actor it was when no person did. */
  readonly actorName: string;
  /** The command that was applied, by its surface name. */
  readonly operation: string;
  readonly task: { readonly key: string; readonly title: string | null };
}

/** One day in the reader's zone and every event on it, newest first. */
export interface LedgerDayView {
  /** `YYYY-MM-DD` in the zone the reader asked for. */
  readonly day: string;
  readonly events: readonly LedgerEventView[];
}

/**
 * `task.ledger`'s answer: whole days, newest first, never split across pages.
 * `earlier` says whether a day before the last one here has events.
 */
export interface TaskLedgerResult {
  readonly ok: true;
  readonly days: readonly LedgerDayView[];
  readonly earlier: boolean;
  /**
   * Only with `query`: the reader's own matching tasks go past the most the
   * ledger's search reads (C1's bound, 500), so some are not listed.
   */
  readonly more?: boolean;
}

/** A teammate on the Team panel's people strip (MP-7-10): no row is available. */
export interface TeamMemberView {
  readonly personId: string;
  readonly name: string;
  readonly availability: {
    readonly state: 'available' | 'away';
    readonly reason: string | null;
  } | null;
}

export interface TeamListResult {
  readonly ok: true;
  /** The reader's own person, so the panel knows which entry is theirs. */
  readonly you: string;
  readonly people: readonly TeamMemberView[];
}

export interface PersonListResult {
  readonly ok: true;
  readonly persons: readonly PersonView[];
}

/** One gate waiting on a person: `gate.pending`'s row (MP-6-1). */
export interface AwaitingReviewView {
  readonly gateId: string;
  readonly versionId: string;
  readonly version: number;
  readonly lineageId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly purpose: string;
  readonly maximumMinor: number;
  readonly currency: string;
  readonly round: number;
  readonly expiresAt: string;
}

export interface AwaitingReviewResult {
  readonly ok: true;
  readonly awaiting: readonly AwaitingReviewView[];
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
  /** The file an `audit_copy_missing` report is about (AW-04); null for a drop's. */
  readonly contentDigest: string | null;
  readonly runs: readonly {
    readonly taskId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly reactivated: boolean;
  }[];
}

/**
 * AW-04's attribution by digest: the runs whose read ledger holds the file,
 * entry and non-entry alike, and the operations those runs reached. It is
 * pre-review, every row labelled so: it may floor a declaration of reach and
 * nothing else, and no evaluation, promotion or conformance input takes it.
 */
export interface PreReviewAttribution {
  readonly label: 'pre-review';
  readonly digest: string;
  readonly runs: readonly PreReviewRun[];
  /** Every operation any run below reached (a refused call reached nothing). */
  readonly operations: readonly string[];
}

export interface PreReviewRun {
  readonly label: 'pre-review';
  readonly taskId: string;
  readonly runId: string;
  /** The paths the run read the file at. */
  readonly paths: readonly string[];
  /** Whether the file was the run's entry file. */
  readonly entry: boolean;
  readonly operations: readonly string[];
}

/** `definition.attribution`'s answer. */
export interface AttributionResult {
  readonly ok: true;
  readonly attribution: PreReviewAttribution;
}

/** `preset.plan`'s answer: a dry-run plan that installs and approves nothing. */
export interface PresetPlanResult {
  readonly ok: true;
  readonly plan: PresetPlan;
}

/** One task a search found: enough to list it and to open it. */
export interface SearchHit {
  readonly id: string;
  readonly key: string;
  readonly title: string | null;
}

/** `task.search`'s answer. No match in scope is `[]`, and there is no count. */
export interface TaskSearchResult {
  readonly ok: true;
  readonly hits: readonly SearchHit[];
  /** Only for a server caller that passed a limit: its own matches go past it. */
  readonly more?: boolean;
}

export interface SettingsReadResult {
  readonly ok: true;
  readonly settings: readonly SettingView[];
  /**
   * The AI planning chat's budget (AW-04): the business's planning cap, AUD 50
   * until a person moves it. `set` is false while it is that default.
   */
  readonly planningCap: {
    readonly limitMinor: number;
    readonly currency: string;
    readonly set: boolean;
  };
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
  /** The plan its run was proposed under, as recorded (MP-6-2); absent from an older read. */
  readonly placement?: {
    /** The bound plan record, or null when the run was proposed under none. */
    readonly planRecordId: string | null;
    readonly stepKey: string | null;
    /** The plan's own run, or a run of its lineage. */
    readonly planRun: boolean;
  };
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
  /** Planned and observed per run (AW-06); every reader who may see the task gets the same one. */
  readonly graph: ExecutionGraph;
  /** The steps of each bound plan record a run of the task was proposed under (MP-6-2). */
  readonly plans?: readonly {
    readonly planRecordId: string;
    readonly steps: readonly { readonly key: string; readonly title: string }[];
  }[];
}

/**
 * Planned and observed per run (AW-06). With AW-04's plan record bound to its
 * approval, `plan` is `bound` and `steps` lists the plan's steps with the runs
 * proposed under each; unbound, `steps` is empty and no node is planned.
 */
export interface ExecutionGraph {
  readonly plan: 'bound' | 'unbound';
  /** Absent on a read made before AW-04's plan was projected. */
  readonly steps?: readonly ExecutionStep[];
  readonly sourceRevision: number;
  readonly complete: boolean;
  readonly nodes: readonly ExecutionNode[];
}

/** A step of the bound plan, with the runs proposed under it. */
export interface ExecutionStep {
  readonly key: string;
  readonly title: string;
  readonly after: readonly string[];
  readonly runIds: readonly string[];
}

export interface ExecutionNode {
  readonly nodeId: string;
  readonly condition: 'not_started' | 'in_progress' | 'settled' | 'superseded' | 'unrecognised';
  /** The bound plan's step this run was proposed under, or null. */
  readonly planned: { readonly key: string; readonly title: string } | null;
  readonly observed: {
    readonly condition: ExecutionNode['condition'];
    readonly runState: string;
    readonly attemptId: string | null;
    readonly whoseMove: {
      readonly kind: 'agent' | 'person';
      readonly actorId: string | null;
    } | null;
    readonly outcome: string | null;
    readonly fault: string | null;
    readonly lease: { readonly state: string; readonly expiresAt: string } | null;
    readonly effectObserved: boolean;
    /** Null when nothing is held or spent: absent money is never 0. */
    readonly heldMinor: number | null;
    readonly spentMinor: number | null;
    readonly currency: string;
  };
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

/** A pointer a wrap-up holds: what it names and the address that opens it (AW-03). */
export interface ConversationPointerView {
  readonly kind: 'task' | 'run' | 'gate' | 'conversation';
  readonly id: string;
  readonly address: string;
  /** The item's state when the wrap-up was written, where it has one. */
  readonly state?: string;
}

/** One of a wrap-up's seven pointer-and-fact contents. */
export interface WrapUpItemView {
  readonly key: string;
  readonly fact: string;
  readonly pointers: readonly ConversationPointerView[];
}

export interface WrapUpView {
  readonly version: number;
  readonly writtenAt: string;
  readonly writtenBy: { readonly operation: string; readonly codeRevision: string };
  readonly definitionVersion: string | null;
  /** The request, as a marked quotation: the first message, never a transcript. */
  readonly request: { readonly quotation: string };
  readonly items: readonly WrapUpItemView[];
  /** Item 8, what was left open. Empty is "nothing left open". */
  readonly leftOpen: readonly ConversationPointerView[];
  readonly leftOpenText: string;
}

export interface ConversationMessageView {
  readonly id: string;
  readonly role: 'person' | 'agent';
  readonly body: string;
  readonly createdAt: string;
}

/** One of the caller's own conversations, as the assistant panel's tab row draws it (MP-7-11). */
export interface ConversationTabView {
  readonly id: string;
  readonly address: string;
  readonly title: string;
  readonly lastActivityAt: string;
  readonly bodyPurged: boolean;
}

/** The caller's own conversations, newest activity first; nobody else's. */
export interface ConversationListResult {
  readonly ok: true;
  readonly conversations: readonly ConversationTabView[];
}

export interface ConversationReadResult {
  readonly ok: true;
  readonly conversation: {
    readonly id: string;
    readonly address: string;
    readonly title: string;
    readonly subject: string | null;
    readonly scope: { readonly kind: 'task'; readonly id: string } | null;
    /** The page added to its context (MP-7-11): one slot, a second replaces it. */
    readonly page: { readonly address: string; readonly shows: string } | null;
    readonly createdAt: string;
    readonly lastActivityAt: string;
    readonly bodyPurgedAt: string | null;
  };
  /** The body, or null once it has purged: the address then answers the wrap-up. */
  readonly messages: readonly ConversationMessageView[] | null;
  /** The current wrap-up version, or null before the first quiet. */
  readonly wrapUp: WrapUpView | null;
  /** Every version, newest first. */
  readonly wrapUpHistory: readonly { readonly version: number; readonly writtenAt: string }[];
}

/**
 * Who is signed in (C23): the caller's own name, for the person menu, and
 * nothing else about anybody. No identifier: the menu needs none, and an answer
 * that carries only a name cannot carry someone else's.
 */
export interface SessionPersonResult {
  readonly ok: true;
  readonly person: { readonly name: string };
}

/** One permission in effect: an action on a collection, over the scope it reaches. */
export interface AccessPermission {
  readonly collection: string;
  readonly action: Action;
  /** `id` is null exactly at business scope; a client is a `party`. */
  readonly scope: { readonly kind: 'business' | 'party' | 'record'; readonly id: string | null };
}

/** One live grant row naming a person or their acting identity: what `access.revoke` takes. */
export interface AccessGrant extends AccessPermission {
  readonly grantId: string;
}

/**
 * A permission a person may use now, and whether the command path first asks
 * the money step-up (C59) for it: a recent second factor, or for a client a
 * recent sign-in. True exactly when `asksMoneyStepUp` is.
 */
export interface AccessPreview extends AccessPermission {
  readonly stepUp: boolean;
}

/**
 * A person on Team or Clients, with the preview of what they may do now and
 * the live grants behind it, each by id, so one can be revoked.
 */
export interface AccessPerson extends PersonView {
  readonly permissions: readonly AccessPreview[];
  readonly grants: readonly AccessGrant[];
}

/** An agent on a live delegation, under the person record it draws on. */
export interface AccessAgent {
  readonly agentActorId: string;
  readonly delegationId: string;
  readonly purpose: string;
  readonly person: PersonView;
  readonly expiresAt: string;
  /** Its delegation's narrowing of its person's grants, on the one record it is for. */
  readonly permissions: readonly AccessPermission[];
}

/**
 * `access.read`'s answer (C32). The three lists are one set of `people` rows:
 * Team is the assignee list, Clients the people without a membership who
 * stand on a live grant, and each agent names its person rather than copying it.
 */
export interface AccessReadResult {
  readonly ok: true;
  readonly team: readonly AccessPerson[];
  readonly clients: readonly AccessPerson[];
  readonly agents: readonly AccessAgent[];
  /** The business's client records, which a `party` scope in a preview names. */
  readonly clientRecords: readonly ClientView[];
}

/** One client record (C32): an organisation the business works for. */
export interface ClientView {
  readonly clientId: string;
  readonly name: string;
}

/** `client.list`'s answer: the clients the caller's live grants reach. */
export interface ClientListResult {
  readonly ok: true;
  readonly clients: readonly ClientView[];
}

/** One privacy incident record on the operations view (C55, SP-24). */
export interface PrivacyIncidentView {
  readonly id: string;
  readonly whatHappened: string;
  /** Day 0, ISO 8601. */
  readonly foundAt: string;
  readonly foundBy: string;
  readonly affected: string;
  readonly informationKinds: readonly string[];
  /** Day 0 plus 30 days: the runbook's assessment limit. */
  readonly assessBy: string;
  /** Still open past `assessBy`, judged on the database's clock (C81 breach drill). */
  readonly overdue: boolean;
  readonly status: 'open' | 'closed';
  readonly recordedAt: string;
  readonly recordedByActorId: string;
}

/** The breach runbook an incident record links to: the version published most recently (C81). */
export interface BreachRunbookLink {
  readonly version: string;
  readonly digest: string;
  readonly publishedAt: string;
  readonly body: string;
}

/** Where a service-health reading comes from (C34). */
export type HealthSourceName = 'watcher' | 'error-sink' | 'tracing';

/**
 * Whether a source could be read. `off` is an optional source switched off,
 * never a failure; `read-failure` says nothing about the services it watches.
 */
export type HealthSourceState = 'read' | 'read-failure' | 'off';

/** Why a source could not be read, by kind only: never the source's own words. */
export type HealthFault =
  'unconfigured' | 'refused' | 'malformed' | 'oversized' | 'slow' | 'unreachable';

/**
 * One service as its source last saw it. Four states kept apart: a service
 * never observed, one whose last observation is stale, one that failed, and
 * one that is healthy.
 */
export type ServiceHealthState = 'healthy' | 'service-failure' | 'stale' | 'never-observed';

export interface HealthSourceView {
  readonly source: HealthSourceName;
  readonly state: HealthSourceState;
  readonly fault: HealthFault | null;
}

export interface ServiceHealthView {
  readonly source: HealthSourceName;
  readonly name: string;
  readonly state: ServiceHealthState;
  /** ISO 8601, or null when never observed. */
  readonly lastObservedAt: string | null;
}

/** The service-health section of the operations view (C34). */
export interface ServiceHealthSection {
  readonly checkedAt: string;
  readonly sources: readonly HealthSourceView[];
  readonly services: readonly ServiceHealthView[];
}

/**
 * One security alert S0-2's forwarder raised, as the operations view lists it
 * (C55): its kind, the time it was raised (ISO 8601) and fixed plain
 * words for what it concerns; 'An alert of an unknown kind' for a kind the
 * view has no words for. Never an id, a secret or record content.
 */
export interface SecurityAlertView {
  readonly kind: string;
  readonly at: string;
  readonly concerns: string;
}

/**
 * `operations.read`'s answer (C55). The privacy incidents are this business's
 * own records. The service-health section (C34) is the installation's
 * watcher, error sink and optional tracing, read by the API after the grant
 * check and outside the serving transaction. The unattended items are INB-1's
 * own read (`inbox.unattended`'s answer). `operations.read` serves the
 * security alerts (S0-2) from the forwarder's log (0069), newest first, at
 * most 50, to the business that operates the installation alone; every other
 * business reads an empty list. The last tested restore (C55, carried from
 * S0-3) is the date a passed drill stamps (0070), served on every answer. The
 * API adds the error sink's web address, `OPS_ERROR_SINK_URL`, beside the
 * service-health section; each is its owner's read, placed here, never a
 * second copy.
 */
export interface OperationsReadResult {
  readonly ok: true;
  /** INB-1's unattended items whose task the caller reads: every path to a person broken. */
  readonly unattended: readonly UnattendedView[];
  readonly privacyIncidents: readonly PrivacyIncidentView[];
  /** What every incident record links to; `null` until a breach runbook is published. */
  readonly breachRunbook: BreachRunbookLink | null;
  /** Present on every answer the API serves; absent from a read made in-process. */
  readonly serviceHealth?: ServiceHealthSection;
  readonly securityAlerts?: readonly SecurityAlertView[];
  /**
   * The last tested restore a passed drill stamped (0070); `stale` past the
   * store's restore window or while no drill has passed.
   */
  readonly lastTestedRestore?: LastTestedRestoreView;
  /** The error sink's web address; `null` with none set; absent from an in-process read. */
  readonly errorSink?: { readonly url: string } | null;
}

/** The drill receipt's last successful tested restore (S0-3). */
export interface LastTestedRestoreView {
  /** ISO 8601, or null when no restore has been tested. */
  readonly at: string | null;
  /** The restore alert has fired since. */
  readonly stale: boolean;
}

/** One notice the breach runbook's template drafts; nothing sends it (owner line 54). */
export interface BreachNoticeDraft {
  readonly to: 'oaic' | 'person';
  readonly name: string;
  readonly address: string;
  readonly subject: string;
  readonly body: string;
}

/**
 * `privacy.draft_breach_notices`' answer (C81 breach drill): the runbook
 * version drafted from, and the notice to the OAIC first, then one per person.
 */
export interface BreachNoticesResult {
  readonly ok: true;
  readonly runbook: { readonly version: string; readonly digest: string };
  readonly notices: readonly BreachNoticeDraft[];
}

/**
 * One of the caller's own inbox items (INB-1d). The pointers, the task's key
 * and title, and the decider's name are present only while the caller can
 * read the task: a gone entry keeps its own identity and axes and names
 * nothing of the task or the fact it points at (INB-1g reads them at the same
 * read, so the item stays a pointer and never a copy).
 */
export interface InboxEntry {
  readonly id: string;
  readonly reason: InboxReason;
  readonly workState: InboxWorkState;
  readonly access: InboxAccess;
  readonly owed: boolean;
  /** Open, owed and readable now: exactly what the count counts. */
  readonly counted: boolean;
  readonly raisedAt: string;
  readonly closedAt: string | null;
  readonly seenAt: string | null;
  /** The last delivery attempt's state; asked, accepted and delivered are three words. */
  readonly lastDelivery: DeliveryState | null;
  readonly subjectRecordId?: string;
  readonly factKind?: InboxFactKind;
  readonly factId?: string;
  readonly closedByPersonId?: string | null;
  /** The task the item is about, for its link and its name. */
  readonly task?: { readonly key: string; readonly title: string | null };
  /** Who closed it, by name: a cleared decision names who decided. */
  readonly closedBy?: PersonView | null;
  /**
   * The task's client (MP-7-3's group), only where the caller reaches that
   * client as `client.list` does; a caller holding the task alone is not told.
   */
  readonly client?: { readonly clientId: string; readonly name: string };
  /**
   * T2h's alert on the run a readable item points at: the same record the task
   * page and the queue read show (INB-1, the alert's third and last place).
   */
  readonly alert?: InboxAlert;
}

/** An item no path reaches (INB-1e): its recipient, reason and task, never the task's words. */
export interface UnattendedView {
  readonly id: string;
  readonly recipientPersonId: string;
  readonly subjectRecordId: string;
  readonly reason: InboxReason;
  readonly factKind: InboxFactKind;
  readonly factId: string;
  readonly raisedAt: string;
}

/** `inbox.read`'s answer: the caller's open items and newest page of closed ones, oldest raised first. */
export interface InboxReadResult {
  readonly ok: true;
  readonly inbox: readonly InboxEntry[];
}

/** `inbox.count`'s answer: the list's counted entries, under the same rule. */
export interface InboxCountResult {
  readonly ok: true;
  readonly owed: number;
}
