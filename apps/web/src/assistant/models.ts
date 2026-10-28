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

/** A write's outcome: 'unknown' where its answer was lost, 'held' where no conversation is started. */
export type Outcome = 'kept' | 'refused' | 'unknown' | 'held';

/** A write in the tab's turn, then its outcome; the tab's next write and question wait for `after`. */
export type Written = (
  key: string,
  write: (conversationId: string) => Promise<CallResult<CommandOutcome>>,
  after?: (outcome: Outcome, conversationId: string | null) => Promise<void>,
) => void;

/** The model the server has for a conversation, null for the default; undefined if unread. */
async function keptOn(client: OperationsClient, conversationId: string) {
  const answer = await client.read<ConversationModelsResult>('conversation.models', {
    conversationId,
  });
  return isRefusal(answer) || isUnavailable(answer) ? undefined : (answer.value.chosen ?? null);
}

/** Why a question waits unsent: its tab's model is not known since a switch's answer was lost. */
export const UNREAD_MODEL =
  'Not sent: this conversation’s model could not be read back after the switch. Ask again shortly.';

/** Whether a tab's model is known before its next question goes (`useModelChoice`). */
export type Confirm = (key: string, conversationId: string) => Promise<boolean>;

interface Tab {
  /** The model the server has, null for the default; undefined while a lost answer is unread. */
  readonly kept: string | null | undefined;
  readonly last: number;
  /** The switch whose answer is unread, marked once the server says it kept it. */
  readonly unread?: { readonly model: string; readonly since: string[] | null };
}

/**
 * Each tab's choice of model (#2175), shown at once and sent in the tab's turn. Once the server keeps
 * it, a switch is marked before any question asked since, as those waited for it. Once refused, the
 * tab shows again the model the server still has, unless another was chosen since. A lost answer is
 * read back (S2194-9); while that read fails too, the tab's model is unread, and `confirm` reads it
 * again before the tab's next question goes, which waits unsent until it is known (S2194-10). A tab
 * with no conversation yet holds the choice for its start.
 */
export function useModelChoice(client: OperationsClient, store: Store) {
  const [tabs] = useState(() => new Map<string, Tab>());
  // The server has `server` after the switch to `model`: marked if kept, else shown if latest.
  const settled = (key: string, server: string | null, to: Tab['unread'], latest: boolean) => {
    tabs.set(key, { kept: server, last: tabs.get(key)?.last ?? 0 });
    const { model, since } = to ?? { model: undefined, since: null };
    if (server === model && since !== null)
      store.update((current) => markSwitch(current, key, server, since));
    if (server !== model && latest) store.update((current) => chooseModel(current, key, server));
  };
  const choose = (key: string, model: string, written: Written): void => {
    const chat = store.chat(key);
    const since = switching(chat, model) ? askedSoFar(chat) : null;
    const was = tabs.get(key) ?? { kept: chat?.model ?? null, last: 0 };
    const choice = was.last + 1;
    tabs.set(key, { ...was, last: choice });
    store.update((current) => chooseModel(current, key, model));
    const write = (conversationId: string) =>
      client.mutate('conversation.set_model', { conversationId, model });
    written(key, write, async (outcome, conversationId) => {
      const read =
        outcome === 'unknown' && conversationId !== null
          ? await keptOn(client, conversationId)
          : undefined;
      const now = tabs.get(key) ?? was;
      const latest = now.last === choice;
      if (outcome === 'unknown' && read === undefined)
        tabs.set(key, { ...now, kept: undefined, unread: { model, since } });
      else if (outcome === 'unknown') settled(key, read ?? null, { model, since }, latest);
      else if (outcome === 'refused' && now.kept !== undefined)
        settled(key, now.kept, { model, since: null }, latest);
      else if (outcome !== 'refused')
        settled(key, model, { model, since: outcome === 'held' ? null : since }, latest);
    });
  };
  // Whether tab `key`'s model is known, reading it back first while unread (S2194-10); the read is
  // shown only if no model was chosen while it waited (S2194-11).
  const confirm: Confirm = async (key, conversationId) => {
    const tab = tabs.get(key);
    if (tab === undefined || tab.kept !== undefined) return true;
    const read = await keptOn(client, conversationId);
    if (read === undefined) return false;
    settled(key, read, tab.unread, tabs.get(key)?.last === tab.last);
    return true;
  };
  return { choose, confirm };
}
