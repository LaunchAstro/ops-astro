// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11: the drawer's shapes, in one module its parts and its caller share,
// so no part imports the panel that imports it.

import type { ReactNode } from 'react';

export type AssistantRole = 'user' | 'ai' | 'note' | 'failed' | 'plan';

/**
 * AW-04: a plan version drawn as a card in the chat. `offered` carries the one
 * accept; `accepting` while the click is in flight; `approved` once the server
 * kept the words; `unknown` when the click got no answer, its accept offered
 * again under the same operation id even once replaced; `stale` once a newer
 * version replaced it in this chat.
 */
export type PlanCardState = 'offered' | 'accepting' | 'approved' | 'unknown' | 'stale';

export interface AssistantPlan {
  readonly version: number;
  /** The exact words the click binds, drawn on the card as they are sent. */
  readonly text: string;
  /** Each step's title, and the titles of the steps it waits on. */
  readonly steps: readonly { readonly title: string; readonly after: readonly string[] }[];
  /** The bootstrap file the click activates, and the other files the run may read. */
  readonly entryPath: string;
  readonly paths: readonly string[];
  readonly ceilingMinor: number;
  readonly spendMinor: number;
  readonly currency: string;
  readonly state: PlanCardState;
  /** The version that replaced this one, on a stale card. */
  readonly replacedBy: number | null;
  /** The server's refusal of the last click, quoted as it came. */
  readonly refusal: string | null;
  readonly task: { readonly label: string; readonly href: string };
}

/**
 * The chat path's task proposal card: `offered` carries the one click,
 * `sending` while it is out, `made` once the server kept the task, `unknown`
 * when the click got no answer, its click offered again, and `stale` when an
 * edit can no longer apply as proposed, with no click.
 */
export type ProposalCardState = 'offered' | 'sending' | 'made' | 'unknown' | 'stale';

/** One task an edit card may apply to, as `task.read` gives it now. */
export interface AssistantPickRow {
  readonly id: string;
  readonly title: string;
  readonly key: string;
}

/**
 * #1666: in a chat opened on no task, the tasks it created that an edit card
 * may apply to. `required` (it created more than one) lists them for the
 * person to pick, none chosen; otherwise the one is named. Rows are read live,
 * a page at a time in the targets' order.
 */
export interface AssistantPick {
  readonly required: boolean;
  /** Each target's task and the revision kept with the reply, in order. */
  readonly targets: readonly { readonly taskId: string; readonly revision: number }[];
  /** The page of targets shown, from 0. */
  readonly page: number;
  /** The rows of that page the reader may read; null while they are read. */
  readonly rows: readonly AssistantPickRow[] | null;
  /** The task the click applies to: the person's pick, or the one named. */
  readonly chosen: string | null;
  /** The click went with `chosen`, so it no longer changes. */
  readonly frozen: boolean;
}

/** A person's move on the pick: a task chosen, or another page shown. */
export type AssistantPickMove = { readonly choose: string } | { readonly page: number };

export interface AssistantProposal {
  /** A new task, or an edit of the task the chat is open on or one it created. */
  readonly action: 'create' | 'edit';
  /** The words the click sends, drawn as they are sent; null is not changed. */
  readonly title: string | null;
  readonly description: string | null;
  /** The task's Due day (`YYYY-MM-DD`) and Estimate in minutes, where proposed. */
  readonly due?: string;
  readonly estimate?: number;
  readonly state: ProposalCardState;
  /** The task made or changed, once the server kept it. */
  readonly task: { readonly label: string; readonly href: string } | null;
  /** The server's refusal of the last click, quoted as it came. */
  readonly refusal: string | null;
  /** An edit in a chat on no task: the tasks it may apply to. */
  readonly pick?: AssistantPick;
}

export interface AssistantCite {
  readonly label: string;
  readonly href: string;
}

export interface AssistantMessage {
  readonly id: string;
  readonly role: AssistantRole;
  readonly body: string;
  readonly cites: readonly AssistantCite[];
  /** On a `plan` message: the card. */
  readonly plan?: AssistantPlan;
  /** On an `ai` message whose reply ended in a task block: the card. */
  readonly proposal?: AssistantProposal;
  /** On an `ai` message still being written: provisional, until the settled reply replaces it. */
  readonly writing?: boolean;
}

export interface AssistantPage {
  readonly address: string;
  readonly shows: string;
}

export interface AssistantChat {
  readonly key: string;
  readonly title: string;
  readonly model: string | null;
  readonly page: AssistantPage | null;
  readonly messages: readonly AssistantMessage[];
}

export interface AssistantModel {
  readonly id: string;
  readonly label: string;
  /** Why the model cannot be chosen now, in words; absent, it is on offer. */
  readonly unavailable?: string;
}

export interface AssistantOffer {
  readonly models: readonly AssistantModel[];
  readonly waiting: string | null;
}

export interface AssistantCitation {
  readonly row: string;
  readonly id: string;
  readonly label: string;
}

export interface AssistantSubjectView {
  readonly label: string;
  readonly placeholder: string;
  readonly chips: readonly string[];
}

/** One of the person's own past conversations, as the history list draws it (CS-7.33, C36). */
export interface AssistantPast {
  readonly id: string;
  readonly title: string;
  readonly lastActivityAt: string;
}

/**
 * The drawer's history: shown, it asks `onShow` to read the list, then draws
 * it; `said` is why there is none to draw. A row opens its conversation as a tab.
 */
export interface AssistantHistory {
  readonly past: readonly AssistantPast[] | null;
  readonly said: string | null;
  readonly onShow: () => void;
  readonly onOpen: (id: string) => void;
}

export interface AssistantPanelProps {
  readonly subject: AssistantSubjectView;
  readonly chats: readonly AssistantChat[];
  readonly selected: string;
  readonly offer: AssistantOffer;
  /** The selected tab's own address (C36), once its conversation has started. */
  readonly address?: string | null;
  readonly citation: AssistantCitation | null;
  /** The caller's planning allowance line (AW-04), drawn above the transcript. */
  readonly allowance?: ReactNode;
  readonly draft: string;
  /** The selected tab has a question out with no answer back yet. */
  readonly answering?: boolean;
  /** The person's past conversations; absent, the drawer offers no history. */
  readonly history?: AssistantHistory;
  readonly onSelect: (key: string) => void;
  readonly onRename: (key: string, title: string) => void;
  readonly onTakeOut: (key: string) => void;
  readonly onNew: () => void;
  readonly onModel: (key: string, model: string) => void;
  readonly onAddPage: (key: string) => void;
  /** The question for the tab; a promise returned is the send being out. */
  readonly onSend: (key: string, text: string) => void | Promise<void>;
  /** AW-04: the one click on a plan card, by tab and message. Absent, no accept is drawn. */
  readonly onAccept?: (key: string, messageId: string) => void;
  /** The one click on a task proposal card, by tab and message. Absent, no click is drawn. */
  readonly onPropose?: (key: string, messageId: string) => void;
  /** A move on an edit card's pick, by tab and message. */
  readonly onPick?: (key: string, messageId: string, move: AssistantPickMove) => void;
  /** The drawer's own close, with its title: absent when a host's head (the dock's) frames it. */
  readonly onClose?: (() => void) | undefined;
}
