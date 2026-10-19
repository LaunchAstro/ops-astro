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
// straight after the start, then each later choice in turn, landing before the next question.
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
import { AssistantPanel } from '@launchastro/ui';
import {
  addPage,
  ask,
  asking,
  chooseModel,
  fresh,
  rename,
  select,
  takeOut,
  type Chat,
} from '../assistant/chats.ts';
import { entryFor, type EntryPoint } from '../assistant/entries.ts';
import { acceptPlanCard } from '../assistant/accept.ts';
import { keepBaseline, sendProposal, type Baseline } from '../assistant/proposals.ts';
import { useAsks } from '../assistant/asks.ts';
import { useHistoryList, useKeptStore, type KeptStore } from '../assistant/kept.ts';
import { answersTo, type Store } from '../assistant/store.ts';
import { useModels } from '../assistant/models.ts';
import { modelOffer, subjectFor, type Subject } from '../assistant/subject.ts';
import {
  askAgain,
  setModel,
  setScope,
  startWith,
  type Context,
  type Opening,
  type Replays,
  type Sent,
} from '../assistant/first-question.ts';
import { resends } from '../assistant/resend.ts';
import type { OperationsClient } from '../operations/client.ts';
import { settle } from '../records/use-command.ts';
import { pathTo, ROUTES, type RouteId } from '../routes.ts';
import { AllowanceLine } from './allowance-line.tsx';
import { besideAllowance, type CorrectionHost } from './correction-card.tsx';

export { KEPT } from '../assistant/first-question.ts';

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

/**
 * The answers' store, except that an answer's edit is bound by the attempt
 * that carried it, to what that attempt first read (`first-question.ts`),
 * never to this send's read.
 */
function boundByAttempt(
  heard: { readonly on: Store; readonly read: Promise<Baseline | null> },
  store: Store,
  question: string,
): { readonly on: Store; readonly read: Promise<Baseline | null> } {
  const answer: Store['answer'] = (at, reply, _after, cites) =>
    store.answer(at, reply, question, cites);
  return { on: { ...heard.on, answer }, read: heard.read };
}

/** The start, the join, and every write after them, each refusal shown in the tab. */
function useSender(props: AssistantViewProps, store: Store, subject: Subject) {
  const starts = useRef(new Map<string, Promise<string | null>>());
  const replays: Replays = {
    resent: useRef(resends<Context>()).current,
    keep: (reply, at) => {
      keepBaseline(props.grantKey, reply, at);
    },
  };
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
    startWith({ client: props.client, store, report, replays }, on, { ...opening, subject });
  const send = async (key: string, body: string): Promise<void> => {
    const chat = store.chat(key);
    if (chat === undefined) return;
    const question = store.line(key, 'user', body);
    // The asking tab's scope, as the question is asked: a tab selected while
    // its task is read changes neither the start nor the card.
    const opening = { chat, body, scope: scope() };
    const { on, read } = boundByAttempt(answersTo(props, store, chat, question), store, question);
    // Each question waits for the tab's writes so far and then its task's
    // read, in the tab's queue, so a model chosen after it lands after it.
    // A tab not yet started joins what its last start made, or starts itself
    // only once that start is refused. A lost start resent goes as that start
    // whatever the tab is on now, so it replays rather than asks again (#897).
    let asked = false;
    let baseline: Baseline | null = null;
    const before = starts.current.get(key) ?? Promise.resolve(chat.conversationId);
    const turn = before.then(async (id) => {
      baseline = await read;
      if (id !== null && !replays.resent.holds(key, 'conversation.start', body)) return id;
      asked = true;
      const made = await start({ ...opening, baseline, question }, on);
      return id ?? made;
    });
    starts.current.set(key, turn);
    const known = await turn;
    if (asked || known === null) return;
    await askAgain(props.client, on, key, { conversationId: known, body, baseline }, replays);
  };
  return { report, send, starts: starts.current };
}

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
  const written = (key: string, write: (conversationId: string) => Sent): void => {
    // A tab kept or reopened was started elsewhere: its conversation is known.
    const known = Promise.resolve(store.chat(key)?.conversationId ?? null);
    const turn = (sender.starts.get(key) ?? known).then(async (id) => {
      if (id !== null) await sender.report(key, write(id));
      return id;
    });
    sender.starts.set(key, turn);
  };
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
    chooseModel: (key, model) => {
      store.update((current) => chooseModel(current, key, model));
      written(key, (conversationId) => setModel(props.client, conversationId, model));
    },
  };
}

/** The tab's allowance line, read again as each of its answers settles. */
function allowanceFor(client: OperationsClient, chat: Chat | undefined): ReactElement {
  // Every message but the person's own is a settled answer: a reply, a note or a failure.
  const settled =
    chat?.messages.filter((line) => line.role !== 'user' && line.writing !== true).length ?? 0;
  const conversationId = chat?.conversationId ?? null;
  return <AllowanceLine client={client} conversationId={conversationId} settled={settled} />;
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
  const models = useModels(props.client, opened);
  return (
    <AssistantPanel
      subject={subject}
      chats={state.chats}
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
      onNew={() => {
        update(fresh);
      }}
      onModel={writes.chooseModel}
      onAddPage={writes.addPage}
      onSend={answering(store, sender.send)}
      onAccept={(key, id) => void acceptPlanCard(props, store, { key, id })}
      onPropose={(key, id) => void sendProposal(props, store, { key, id })}
      onClose={props.onClose}
    />
  );
}
