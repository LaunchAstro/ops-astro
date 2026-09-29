// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11: the drawer's shapes, in one module its parts and its caller share,
// so no part imports the panel that imports it.

export type AssistantRole = 'user' | 'ai' | 'note' | 'failed';

export interface AssistantCite {
  readonly label: string;
  readonly href: string;
}

export interface AssistantMessage {
  readonly id: string;
  readonly role: AssistantRole;
  readonly body: string;
  readonly cites: readonly AssistantCite[];
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
  readonly citation: AssistantCitation | null;
  readonly draft: string;
  readonly onSelect: (key: string) => void;
  readonly onRename: (key: string, title: string) => void;
  readonly onTakeOut: (key: string) => void;
  readonly onNew: () => void;
  readonly onModel: (key: string, model: string) => void;
  readonly onAddPage: (key: string) => void;
  readonly onSend: (key: string, text: string) => void;
  readonly onClose: () => void;
}
