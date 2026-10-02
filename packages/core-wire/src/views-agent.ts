// SPDX-License-Identifier: AGPL-3.0-only
//
// The run ledger a task read carries (T2e, AW-05, MP-6-2) and a person's
// conversation with the agent (AW-03, MP-7-11) and the gates waiting on a
// person (MP-6-1), as the wire carries them.
// Split from `views.ts`, which re-exports every one, to keep that file under
// the 1,000-line cap. Types only, like `views.ts`.

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
