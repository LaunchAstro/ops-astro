// SPDX-License-Identifier: AGPL-3.0-only
//
// The run ledger a task read carries (T2e, AW-05, MP-6-2) and a person's
// conversation with the agent (AW-03, MP-7-11) and the gates waiting on a
// person (MP-6-1), as the wire carries them, with AW-04's attribution and
// planning allowance. Split from `views.ts` to keep that file under the
// 1,000-line cap; it re-exports the first group, the index exports AW-04's.
// A reservation's attempt view (OW-108.1) moved here for the same cap.
// Types only, like `views.ts`.

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

/**
 * The drawer's planning allowance (AW-04, U10): the business's planning cap,
 * what is left of it across the business, and the caller's own conversation's
 * settled spend and held amount. `set` false is the default cap, AUD 50.
 */
export interface PlanningAllowanceView {
  readonly set: boolean;
  readonly currency: string;
  readonly limitMinor: number;
  readonly leftMinor: number;
  readonly conversation: { readonly spentMinor: number; readonly heldMinor: number };
}

/** `conversation.allowance`'s answer: the team's, and the caller's own spend only. */
export interface AllowanceResult {
  readonly ok: true;
  readonly allowance: PlanningAllowanceView;
}

/**
 * One model a conversation may run on (CS-7.30): its exact id, provider and
 * route reach, and its price-book entry, the per-call ceiling in AUD cents.
 */
export interface ConversationModelView {
  readonly id: string;
  readonly provider: string;
  readonly reach: 'local' | 'cloud';
  readonly ceilingMinor: number;
}

/** `conversation.models`' answer: what the picker offers, and the conversation's choice. */
export interface ConversationModelsResult {
  readonly ok: true;
  readonly models: readonly ConversationModelView[];
  /** The model chosen for the conversation, or null: the default, the first offered. */
  readonly chosen: string | null;
}

/** The attempt a reservation produced, on the proposal read (`ReservationView.attempt`). */
export interface AttemptView {
  readonly id: string;
  readonly state: string;
  readonly dispatchMarker: boolean;
  readonly observed: boolean;
  /** Why the work dropped under it (T3e1), or null: never a person's cancellation. */
  readonly dropCause: string | null;
  /**
   * What the attempt recorded, or null before it records one: `completed`,
   * `failed`, `abandoned` or `unknown`. A failed hand-back releases its hold as
   * a completed one does, so only this tells them apart (OW-108.1).
   */
  readonly outcome: string | null;
}
