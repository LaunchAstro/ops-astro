// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11: the drawer's open conversations and the ask seam (declared shape;
// decided in the next commit).

import type { AssistantChat, AssistantCitation, AssistantPage } from '@launchastro/ui';
import type { ScopeInput } from './subject.ts';

export interface Chat extends AssistantChat {
  readonly conversationId: string | null;
}

export type StandingScope = Pick<ScopeInput, 'client' | 'task'>;

export interface AssistantState {
  readonly chats: readonly Chat[];
  readonly selected: string;
  readonly next: number;
  readonly citation: AssistantCitation | null;
  readonly draft: string;
  readonly scope: StandingScope;
}

export interface AskEntry {
  readonly row: string;
  readonly widget: { readonly id: string; readonly label: string };
  readonly question: string;
  readonly scope: {
    readonly client: StandingScope['client'];
    readonly task: { readonly id: string; readonly title: string } | null;
  };
}

export const FRESH_NOTE = '';

export const initial = (): AssistantState => ({
  chats: [],
  selected: '',
  next: 1,
  citation: null,
  draft: '',
  scope: { client: null, task: null },
});
export const fresh = (state: AssistantState): AssistantState => state;
export const select = (state: AssistantState, _key: string): AssistantState => state;
export const rename = (state: AssistantState, _key: string, _title: string): AssistantState =>
  state;
export const takeOut = (state: AssistantState, _key: string): AssistantState => state;
export const chooseModel = (state: AssistantState, _key: string, _model: string): AssistantState =>
  state;
export const addPage = (
  state: AssistantState,
  _key: string,
  _page: AssistantPage,
): AssistantState => state;
export const ask = (state: AssistantState, _entry: AskEntry): AssistantState => state;
export const openDirect = (state: AssistantState): AssistantState => state;
