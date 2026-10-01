// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11: the drawer's shapes, in one module its parts and its caller share,
// so no part imports the panel that imports it.

export type AssistantRole = 'user' | 'ai' | 'note' | 'failed' | 'plan';

/**
 * AW-04: a plan version drawn as a card in the chat. `offered` carries the one
 * accept; `accepting` while the click is in flight; `approved` once the server
 * kept the words; `stale` once a newer version replaced it in this chat.
 */
export type PlanCardState = 'offered' | 'accepting' | 'approved' | 'stale';

export interface AssistantPlan {
  readonly version: number;
  /** The exact words the click binds, drawn on the card as they are sent. */
  readonly text: string;
  readonly steps: readonly string[];
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

export interface AssistantPanelProps {
  readonly subject: AssistantSubjectView;
  readonly chats: readonly AssistantChat[];
  readonly selected: string;
  readonly offer: AssistantOffer;
  /** The selected tab's own address (C36), once its conversation has started. */
  readonly address?: string | null;
  readonly citation: AssistantCitation | null;
  readonly draft: string;
  readonly onSelect: (key: string) => void;
  readonly onRename: (key: string, title: string) => void;
  readonly onTakeOut: (key: string) => void;
  readonly onNew: () => void;
  readonly onModel: (key: string, model: string) => void;
  readonly onAddPage: (key: string) => void;
  readonly onSend: (key: string, text: string) => void;
  /** AW-04: the one click on a plan card, by tab and message. Absent, no accept is drawn. */
  readonly onAccept?: (key: string, messageId: string) => void;
  readonly onClose: () => void;
}
