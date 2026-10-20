// SPDX-License-Identifier: AGPL-3.0-only
//
// CS-7.30: the models the drawer's picker offers, read from
// `conversation.models` for the selected tab's conversation (none before its
// first question: the install's own models). The server's offer is the
// authority: it filters by the conversation's client's model-egress setting,
// and `conversation.set_model` and the exchange ask the same rule again. An
// answer is kept with the client and conversation it was read for, so another
// tab's models are never drawn here; a refused or unavailable read offers
// nothing. Models the answer names as unavailable (#2175) follow the offered
// ones with their reason in words, for the picker to show and never offer. The
// conversation's kept choice comes with them, so a reopened tab shows the
// model its next question goes to.

import { useEffect, useState } from 'react';
import type { ConversationModelsResult } from '../../../../packages/core-wire/src/index.ts';
import {
  isRefusal,
  isUnavailable,
  type CallResult,
  type CommandOutcome,
  type OperationsClient,
} from '../operations/client.ts';
import { chooseModel, markSwitch, switching } from './chats.ts';
import { askedSoFar } from './page-note.ts';
import type { Store } from './store.ts';
import type { ModelChoice } from './subject.ts';

interface Held {
  readonly client: OperationsClient;
  readonly conversationId: string | null;
  readonly models: readonly ModelChoice[];
  /** The model kept with the conversation, or null: the default. */
  readonly chosen: string | null;
}

const NONE: readonly ModelChoice[] = [];

export function useModels(
  client: OperationsClient,
  conversationId: string | null,
): { readonly models: readonly ModelChoice[]; readonly chosen: string | null } {
  const [held, setHeld] = useState<Held | null>(null);
  useEffect(() => {
    let current = true;
    const load = async (): Promise<void> => {
      const body = conversationId === null ? {} : { conversationId };
      const answer = await client.read<ConversationModelsResult>('conversation.models', body);
      if (!current) return;
      // A refused, unavailable or malformed answer offers nothing.
      const value = isRefusal(answer) || isUnavailable(answer) ? undefined : answer.value;
      const offered = value?.models;
      const shown = Array.isArray(value?.unavailable) ? value.unavailable : [];
      const models = Array.isArray(offered)
        ? [
            ...offered.map((model) => ({ id: model.id, label: model.label ?? model.id })),
            ...shown.map((model) => ({
              id: model.id,
              label: model.label ?? model.id,
              unavailable: model.words,
            })),
          ]
        : NONE;
      const chosen = typeof value?.chosen === 'string' ? value.chosen : null;
      setHeld({ client, conversationId, models, chosen });
    };
    void load();
    return () => {
      current = false;
    };
  }, [client, conversationId]);
  return held?.client === client && held.conversationId === conversationId
    ? held
    : { models: NONE, chosen: null };
}

/** A tab reopened with no choice of its own shows the model its conversation kept (#2175). */
export const keptChoice = <C extends { readonly model: string | null }>(
  chats: readonly C[],
  open: C | undefined,
  chosen: string | null,
): readonly C[] =>
  chats.map((each) =>
    each === open && each.model === null && chosen !== null ? { ...each, model: chosen } : each,
  );

/** A write in the tab's turn, then whether it was kept: null where the tab has no conversation yet. */
export type Written = (
  key: string,
  write: (conversationId: string) => Promise<CallResult<CommandOutcome>>,
  after?: (kept: boolean | null) => void,
) => void;

/**
 * A tab's choice of model (#2175), shown at once and sent in the tab's turn. Once the server keeps
 * it, a switch is marked before any question asked since, as those waited for it. Once refused, the
 * tab shows again the model the server still has, unless another was chosen since. A tab with no
 * conversation yet holds the choice for its start.
 */
export function useModelChoice(
  client: OperationsClient,
  store: Store,
  written: Written,
): (key: string, model: string) => void {
  const [tabs] = useState(() => new Map<string, { kept: string | null; last: number }>());
  return (key, model) => {
    const chat = store.chat(key);
    const since = switching(chat, model) ? askedSoFar(chat) : null;
    const was = tabs.get(key) ?? { kept: chat?.model ?? null, last: 0 };
    const choice = was.last + 1;
    tabs.set(key, { ...was, last: choice });
    store.update((current) => chooseModel(current, key, model));
    const write = (conversationId: string) =>
      client.mutate('conversation.set_model', { conversationId, model });
    written(key, write, (kept) => {
      const now = tabs.get(key) ?? was;
      if (kept !== false) tabs.set(key, { ...now, kept: model });
      if (kept === true && since !== null)
        store.update((current) => markSwitch(current, key, model, since));
      if (kept === false && now.last === choice)
        store.update((current) => chooseModel(current, key, now.kept));
    });
  };
}
