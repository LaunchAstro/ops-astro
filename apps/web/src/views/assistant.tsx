// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11: the drawer on the real conversation commands.
//
// A tab is started by its first question (`conversation.start`) and each later
// question joins it (`conversation.message`). A rename or a page chosen before
// that first question is held in the tab and goes with the start: the title in
// the start itself, the page by `conversation.set_scope` straight after it.
// After that, a rename and a page go to the conversation in turn, in order.
//
// **One start per tab.** A second question asked while the first is still starting waits for it
// and joins the conversation it made, so a quick second press never opens a second conversation.
// Where that start is refused, the next queued question starts the tab and the rest wait on it.
//
// **Nothing about a client's material is sent** (owner line 72): the drawer
// refuses the question itself while the offer is empty with a reason
// (`modelOffer`), so no command leaves for it. The model picker offers what
// `conversation.models` answers for the selected tab (CS-7.30, `assistant/models.ts`);
// a choice is held in the tab until it starts and sent by `conversation.set_model`
// straight after the start, each later one in turn before the next question (`useModelChoice`).
//
// The agent's answer comes back beside each kept question (AW-03's exchange,
// on AW-01's conversation seam) and is drawn after its question, as text, as it
// is written (`assistant/writing.ts`), then settled.
// Where the deployment answers nothing, or no model may take the question,
// the tab says so in plain words: the server's own, for a refusal.
//
// A started tab links to the conversation's own address (C36), where it stays
// after it is taken out of the tab row. The history reopens it as a tab, and
// started tabs come back after a reload, read again (`assistant/kept.ts`); a
// tab with a question out says it is answering.
//
// AW-04: the allowance line sits above the transcript from the start (`allowance-line.tsx`); a
// reply's plan is a card whose one click is `task.accept_plan` (`assistant/plans.ts`); the Agent
// pane's new attempt opens the drawer through `useAsks`, drafted, unsent, its session's alone.

import { useEffect, useRef, type ReactElement } from 'react';
import { AssistantPanel, type AssistantPage } from '@launchastro/ui';
import {
  addPage,
  ask,
  asking,
  fresh,
  rename,
  select,
  started,
  takeOut,
  type Chat,
} from '../assistant/chats.ts';
import { entryFor, type EntryPoint } from '../assistant/entries.ts';
import { acceptPlanCard } from '../assistant/accept.ts';
import { sendProposal } from '../assistant/proposals.ts';
import { usePicks } from '../assistant/picks.ts';
import { citesOf } from '../assistant/cites.ts';
import { useAsks } from '../assistant/asks.ts';
import { useHistoryList, useKeptStore, type KeptStore } from '../assistant/kept.ts';
import { answersTo, type Store } from '../assistant/store.ts';
import { keptChoice, useModelChoice, useModels, type Written } from '../assistant/models.ts';
import { modelOffer, subjectFor, type Subject } from '../assistant/subject.ts';
import { withPieces } from '../assistant/writing.ts';
import type {
  CallResult,
  CommandOutcome,
  ConversationReply,
  OperationsClient,
} from '../operations/client.ts';
import { settle } from '../records/use-command.ts';
import { pathTo, ROUTES, type RouteId } from '../routes.ts';
import { allowanceFor } from './allowance-line.tsx';
import { besideAllowance, type CorrectionHost } from './correction-card.tsx';

export const KEPT = 'Kept in this conversation. The agent does not answer here yet.';

export interface AssistantViewProps {
  readonly client: OperationsClient;
  readonly route: RouteId;
  /** The address of the page being drawn: what "Add page to context" points at. */
  readonly here: string;
  /** The entry point the drawer was last opened from, if any: asked through the one seam. */
  readonly entry: EntryPoint | null;
  /** Its own close and title; the dock leaves it out, as its panel head closes and names it. */
  readonly onClose?: () => void;
  /** The session it serves: it takes a page's ask (`asks.ts`) only from this one, none without it. */
  readonly grantKey?: string;
}

type Sent = Promise<CallResult<CommandOutcome>>;

interface Opening {
  readonly chat: Chat;
  readonly body: string;
  readonly subject: Subject;
  readonly scope: { readonly kind: 'task'; readonly id: string } | null;
}

/** The agent's answer to a kept question, why there is none, or that none comes here. */
function replied(store: Store, key: string, reply: ConversationReply | undefined): void {
  if (reply === undefined) store.line(key, 'note', KEPT);
  else if (reply.answered && reply.plan !== undefined) store.plan(key, reply.body, reply.plan);
  else if (reply.answered) store.answer(key, reply, undefined, citesOf(reply.cites));
  else store.line(key, 'failed', reply.words);
}

/** The tab's first question with its model, its answer, a reopened twin's later lines, then its page. */
async function startWith(
  client: OperationsClient,
  store: Store,
  opening: Opening,
  report: (key: string, sent: Sent) => Promise<boolean>,
): Promise<string | null> {
  const { chat, body, subject, scope } = opening;
  // The tab as the question was asked: a model chosen before it rides in the
  // start, so the first answer is asked of it (CS-7.30); none chosen, the
  // default. A title, page or model chosen while it waits follows it in turn.
  const { title, page, model } = chat;
  const chosen = model === null ? {} : { model };
  const start = { body, title, subject: subject.label, scope, ...chosen, ...(page && { page }) };
  const settled = settle(
    await withPieces(store, chat.key, (by) => client.mutate('conversation.start', start, by)),
  );
  const id = settled.kind === 'ok' ? settled.value.detail?.['conversationId'] : undefined;
  if (typeof id !== 'string') {
    store.line(
      chat.key,
      'failed',
      settled.kind === 'ok' ? 'No conversation came back.' : settled.because,
    );
    return null;
  }
  replied(store, chat.key, settled.kind === 'ok' ? settled.value.reply : undefined);
  store.update((current) => started(current, chat.key, id));
  if (page !== null) await report(chat.key, setScope(client, id, page));
  return id;
}

/** The start, the join, and every write after them, each refusal shown in the tab. */
function useSender(props: AssistantViewProps, store: Store, subject: Subject) {
  const starts = useRef(new Map<string, Promise<string | null>>());
  const report = async (key: string, sent: Sent): Promise<boolean> => {
    const settled = settle(await sent);
    if (settled.kind !== 'ok') store.line(key, 'failed', settled.because);
    return settled.kind === 'ok';
  };
  const scope = (): { readonly kind: 'task'; readonly id: string } | null => {
    const task = store.now().scope.task;
    return subject.kind === 'task' && task !== null ? { kind: 'task', id: task.id } : null;
  };
  const start = (opening: Omit<Opening, 'subject'>, on: Store): Promise<string | null> =>
    startWith(props.client, on, { ...opening, subject }, report);
  const send = async (key: string, body: string): Promise<void> => {
    const chat = store.chat(key);
    if (chat === undefined) return;
    const question = store.line(key, 'user', body);
    // The asking tab's scope, as the question is asked: a tab selected while
    // its task is read changes neither the start nor the card.
    const opening = { chat, body, scope: scope() };
    const { on, read } = answersTo(props, store, chat, question);
    // Each question waits for the tab's writes so far and then its task's
    // read, in the tab's queue, so a model chosen after it lands after it.
    // A tab not yet started joins what its last start made, or starts itself
    // only once that start is refused.
    let asked = false;
    const before = starts.current.get(key) ?? Promise.resolve(chat.conversationId);
    const turn = before.then(async (id) => {
      await read;
      if (id !== null) return id;
      asked = true;
      return await start(opening, on);
    });
    starts.current.set(key, turn);
    const known = await turn;
    if (asked || known === null) return;
    const message = { conversationId: known, body };
    const settled = settle(
      await withPieces(on, key, (by) => props.client.mutate('conversation.message', message, by)),
    );
    if (settled.kind === 'ok') replied(on, key, settled.value.reply);
    else on.line(key, 'failed', settled.because);
  };
  return { report, send, starts: starts.current };
}

const setScope = (client: OperationsClient, conversationId: string, page: AssistantPage): Sent =>
  client.mutate('conversation.set_scope', { conversationId, page });

/** A rename and a page: held in the tab until it starts, then sent after the start, in turn. */
function useWrites(
  props: AssistantViewProps,
  store: Store,
  sender: Pick<ReturnType<typeof useSender>, 'report' | 'starts'>,
): {
  readonly rename: (key: string, title: string) => void;
  readonly addPage: (key: string) => void;
  readonly chooseModel: (key: string, model: string) => void;
} {
  const written: Written = (key, write, after) => {
    // A tab kept or reopened was started elsewhere: its conversation is known.
    const known = Promise.resolve(store.chat(key)?.conversationId ?? null);
    const turn = (sender.starts.get(key) ?? known).then(async (id) => {
      const kept = id === null ? null : await sender.report(key, write(id));
      after?.(kept);
      return id;
    });
    sender.starts.set(key, turn);
  };
  const chooseModel = useModelChoice(props.client, store, written);
  return {
    rename: (key, title) => {
      store.update((current) => rename(current, key, title));
      const kept = store.chat(key)?.title ?? title;
      written(key, (conversationId) =>
        props.client.mutate('conversation.rename', { conversationId, title: kept }),
      );
    },
    addPage: (key) => {
      const page = { address: props.here, shows: ROUTES[props.route].title };
      store.update((current) => addPage(current, key, page));
      written(key, (conversationId) => setScope(props.client, conversationId, page));
    },
    chooseModel,
  };
}

/** The send, with the tab answering while its question is out; a kept tab's read lands first. */
const answering =
  (store: KeptStore, send: (key: string, body: string) => Promise<void>) =>
  async (key: string, body: string): Promise<void> => {
    store.update((current) => asking(current, key, 1));
    try {
      await store.settled(key);
      await send(key, body);
    } finally {
      store.update((current) => asking(current, key, -1));
    }
  };

export function AssistantView(props: AssistantViewProps & CorrectionHost): ReactElement {
  const store = useKeptStore(props.client, props.grantKey);
  const { state, update } = store;
  useEffect(() => {
    const made = props.entry === null ? null : entryFor(props.entry);
    if (made !== null) update((current) => ask(current, made));
    // The store's `update` is a fresh function each render and changes nothing
    // the ask reads; only a new entry is a new ask.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [props.entry]);
  useAsks(props.grantKey, (asked) => update((current) => ask(current, asked)));
  const subject = subjectFor({ route: props.route, ...state.scope });
  const sender = useSender(props, store, subject);
  const writes = useWrites(props, store, sender);
  const chat = state.chats.find((each) => each.key === state.selected);
  const opened = chat?.conversationId ?? null;
  const { models, chosen } = useModels(props.client, opened);
  return (
    <AssistantPanel
      subject={subject}
      chats={keptChoice(state.chats, chat, chosen)}
      selected={state.selected}
      offer={modelOffer(subject, models, null)}
      address={
        opened === null ? null : pathTo('agency:agent-conversation', { conversation: opened })
      }
      citation={state.citation}
      allowance={besideAllowance(allowanceFor(props.client, chat), props)}
      draft={state.draft}
      answering={(state.answering[state.selected] ?? 0) > 0}
      history={useHistoryList(props.client, store)}
      onSelect={(key) => {
        update((current) => select(current, key));
      }}
      onRename={writes.rename}
      onTakeOut={(key) => {
        update((current) => takeOut(current, key));
      }}
      onNew={() => void update(fresh)}
      onModel={writes.chooseModel}
      onAddPage={writes.addPage}
      onSend={answering(store, sender.send)}
      onAccept={(key, id) => void acceptPlanCard(props, store, { key, id })}
      onPropose={(key, id) => void sendProposal(props, store, { key, id })}
      onPick={usePicks(props, store)}
      onClose={props.onClose}
    />
  );
}
