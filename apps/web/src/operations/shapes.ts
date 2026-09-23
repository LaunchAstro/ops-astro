// SPDX-License-Identifier: AGPL-3.0-only
//
// What the reads return, as the slice contract declares them.
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

/**
 * The evidence pack a proposal version was rendered with, as it was stored.
 *
 * `body` is the renderer's output and this build never re-renders it. Evidence
 * that changed between the decision and the display is the one thing a gate
 * cannot survive, so what arrives here is what was on the record when the
 * decision was signed, and the screen prints it rather than formatting it.
 */
export interface ProposalEvidence {
  readonly id: string;
  readonly renderer: string;
  readonly digest: string;
  readonly body: unknown;
}

/**
 * The approval gate on a version.
 *
 * **`expired` is the server's answer.** The `expiresAt` instant is here to be
 * read, not to be compared: a browser with a skewed clock that decided for
 * itself whether a gate was still open would either offer a decision the server
 * will refuse or hide one it would have accepted. The screen closes its controls
 * on this field and on `state`, never on a clock of its own.
 */
export interface ProposalGate {
  readonly id: string;
  readonly state: string;
  readonly round: number;
  readonly expiresAt: string | null;
  readonly expired: boolean;
  readonly payloadDigest?: string;
}

/**
 * One version of a proposal. `versionId` is what `task.decide` compares.
 *
 * The version carries its own digest and its own evidence, and it arrives in
 * the same answer as the gate whose decision would be about it. That is why the
 * projection is on `task.read` rather than behind a read of its own: a screen
 * that fetched the version separately from the evidence could offer a decision
 * on something it never showed anybody.
 */
export interface ProposalVersion {
  readonly versionId: string;
  readonly version: number;
  readonly purpose: string;
  readonly maximumMinor: number;
  readonly currency: string;
  readonly payloadDigest: string;
  readonly payload?: unknown;
  readonly supersededAt: string | null;
  readonly runId: string | null;
  readonly evidence: ProposalEvidence | null;
  readonly gate: ProposalGate | null;
}

/**
 * One link of the decision chain, exactly as it is stored.
 *
 * `hash` and `prevHash` are the stored values and nothing recomputes them on
 * the way here. A projection that handed back a freshly computed hash as though
 * it were the stored one would make a tampered row invisible, so a reader who
 * wants to check the chain has the material to check rather than a summary to
 * trust.
 */
export interface ProposalDecision {
  readonly id?: string;
  readonly seq: number;
  readonly decision: string;
  readonly round: number;
  readonly decidedByPersonId: string | null;
  readonly decidedAt: string;
  readonly signingKeyId?: string;
  readonly signature?: string;
  readonly prevHash?: string | null;
  readonly hash?: string;
}

/** The lease an agent holds on a reservation while it works. */
export interface ProposalLease {
  readonly id: string;
  readonly fence: number;
  readonly state: string;
  readonly expiresAt: string | null;
  readonly holderActorId: string | null;
}

/** What the agent's attempt did, as the runtime recorded it. */
export interface ProposalAttempt {
  readonly id: string;
  readonly state: string;
  readonly dispatchMarker?: string | null;
  readonly observed?: unknown;
}

/**
 * The money an approval set aside, and who is holding it.
 *
 * `heldMinor` is what the approval reserved and `actualMinor` is what the work
 * reported spending; they are different numbers and the screen draws both,
 * because a reservation that held more than it spent is the ordinary case and a
 * screen showing one number cannot say which one it is.
 */
export interface ProposalReservation {
  readonly id: string;
  readonly state: string;
  readonly heldMinor: number | null;
  readonly actualMinor: number | null;
  readonly classifiedCause: string | null;
  readonly leaseId?: string | null;
  readonly lease: ProposalLease | null;
  readonly attempt: ProposalAttempt | null;
}

/**
 * One proposal lineage on a task: its versions, its decisions and its money.
 *
 * Versions arrive newest first and the head is the live one. The decisions are
 * the chain in the order it was written.
 */
export interface ProposalLineage {
  readonly lineageId: string;
  readonly state: string;
  readonly versions: readonly ProposalVersion[];
  readonly decisions: readonly ProposalDecision[];
  readonly reservations: readonly ProposalReservation[];
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
  /**
   * Every proposal on the task, newest lineage first, as `task.read` carried
   * them.
   *
   * It rides on the task detail rather than on a read of its own so that the
   * `versionId` a decision control carries and the evidence a person read come
   * out of one answer (`docs/local/API.md`, "Proposal projection"). The screen
   * draws this and nothing else: it does not re-render the evidence, recompute a
   * hash or decide for itself whether a gate has expired.
   *
   * **Optional, because an answer that omits it is a real answer.** An API
   * without the projection sends a task with no `proposals` key at all, and that
   * is not the same fact as a task with no proposals on it. The screen tells the
   * two apart: an empty list says nobody has proposed anything, and an absent
   * key says this build cannot read them. Defaulting the absent key to an empty
   * list would print "no proposals" over a projection that was never consulted.
   */
  readonly proposals?: readonly ProposalLineage[];
}

/**
 * What a reader outside the business is shown of one task: the server's
 * shared projection (`SharedTaskView` in `packages/core-records`).
 *
 * **It is not a task with parts missing.** There is no title, state, revision,
 * history or proposal on it because the server never read them on this path,
 * and the screen does not ask for them anywhere else. `fields` is keyed by the
 * field's own key and holds only what the catalogue marks `shared`; it is empty
 * when nothing is. `comments` are the client comments in their shared fields.
 */
export interface SharedTask {
  readonly id: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly comments: readonly TaskComment[];
}

/** `task.read` for a reader inside the business: the whole detail. */
export interface InternalTaskRead {
  readonly ok: true;
  readonly task: TaskDetail;
}

/**
 * `task.read` for a reader outside it. Its own key, as on the server, so code
 * that reads `task` can never be handed the narrower view and draw its absent
 * fields as empty ones.
 */
export interface SharedTaskRead {
  readonly ok: true;
  readonly sharedTask: SharedTask;
}

/** Which of the two arrived is decided by the key, never by the reader's role. */
export type TaskReadResult = InternalTaskRead | SharedTaskRead;

export interface TaskBoardResult {
  readonly ok: true;
  readonly tasks: readonly TaskSummary[];
}

export interface PersonListResult {
  readonly ok: true;
  readonly persons: readonly TaskPerson[];
}

/**
 * One row of `settings.read`.
 *
 * `revision` is optional and its absence is a fact about the server, not about
 * the row: `business_settings` gained a revision column in `0020` and the
 * projection does not yet send it, so the screen has to write correctly against
 * both. A row with a revision is written with `expectedRevision`; a row without
 * one is written as the two commands have always taken it.
 */
export interface SettingRow {
  readonly key: string;
  readonly value: unknown;
  readonly valueType?: string;
  readonly updatedAt?: string;
  /** Null is a real answer: the row was written with no actor recorded. */
  readonly updatedByActorId?: string | null | undefined;
  readonly revision?: number;
}

export interface SettingsReadResult {
  readonly ok: true;
  readonly settings: readonly SettingRow[];
}

export interface Grant {
  readonly collection: string;
  readonly action: string;
}

export interface CapabilitiesResult {
  readonly ok: true;
  readonly personId: string;
  readonly businessKey: string;
  readonly grants: readonly Grant[];
}
