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
// **One start per tab.** A second question asked while the first is still
// starting waits for that start and joins the conversation it made, so a
// quick second press never opens a second conversation. Where that start is
// refused, the next queued question starts the tab and the rest wait on it.
//
// **Nothing about a client's material is sent** (owner line 72): the drawer
// refuses the question itself while the offer is empty with a reason
// (`modelOffer`), so no command leaves for it. The model picker holds its
// choice in the tab until conversations carry a model (CS-7.30, on AW-01's
// seam); the catalogue is empty until the business's price book is readable
// here, so the picker offers nothing and the choice is not sent.
//
// The agent's answer comes back beside each kept question (AW-03's exchange,
// on AW-01's conversation seam) and is drawn after its question, as text.
// Where the deployment answers nothing, or no model may take the question,
// the tab says so in plain words: the server's own, for a refusal.
//
// A started tab links to the conversation's own address (C36), where it stays
// after it is taken out of the tab row.
//
// The planning allowance line (AW-04) sits above the transcript, from before
// the first message (`allowance-line.tsx`).

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { AssistantPanel, type AssistantPage, type AssistantRole } from '@launchastro/ui';
import {
  addPage,
  ask,
  chooseModel,
  fresh,
  initial,
  rename,
  said,
  select,
  started,
  takeOut,
  type AssistantState,
  type Chat,
} from '../assistant/chats.ts';
import { entryFor, type EntryPoint } from '../assistant/entries.ts';
import { modelOffer, subjectFor, type ModelChoice, type Subject } from '../assistant/subject.ts';
import type {
  CallResult,
  CommandOutcome,
  ConversationReply,
  OperationsClient,
} from '../operations/client.ts';
import { settle } from '../records/use-command.ts';
import { pathTo, ROUTES, type RouteId } from '../routes.ts';
import { AllowanceLine } from './allowance-line.tsx';

export const KEPT = 'Kept in this conversation. The agent does not answer here yet.';

/** The business's models, empty until its price book is readable here. */
const CATALOGUE: readonly ModelChoice[] = [];

export interface AssistantViewProps {
  readonly client: OperationsClient;
  readonly route: RouteId;
  /** The address of the page being drawn: what "Add page to context" points at. */
  readonly here: string;
  /** The entry point the drawer was last opened from, if any: asked through the one seam. */
  readonly entry: EntryPoint | null;
  /** Its own close and title; the dock leaves it out, as its panel head closes and names it. */
  readonly onClose?: () => void;
}

type Move = (state: AssistantState) => AssistantState;

interface Store {
  readonly state: AssistantState;
  readonly update: (move: Move) => void;
  /** The state as the last move left it, for a step that resumes after a wait. */
  readonly now: () => AssistantState;
  readonly chat: (key: string) => Chat | undefined;
  readonly line: (key: string, role: AssistantRole, body: string, after?: string) => string;
}

/** Tab `key`'s newest line, moved to follow the question `after` and its earlier answers. */
function placed(state: AssistantState, key: string, after?: string): AssistantState {
  const chats = state.chats.map((chat) => {
    const { messages } = chat;
    const from = messages.findIndex((each) => each.id === after);
    const to = messages.findIndex((each, at) => at > from && each.role === 'user');
    if (chat.key !== key || from < 0 || to < 0) return chat;
    return { ...chat, messages: messages.slice(0, -1).toSpliced(to, 0, ...messages.slice(-1)) };
  });
  return { ...state, chats };
}

function useStore(): Store {
  const [state, setState] = useState(initial);
  const latest = useRef(state);
  const count = useRef(0);
  const update = (move: Move): void => {
    latest.current = move(latest.current);
    setState(latest.current);
  };
  return {
    state,
    update,
    now: () => latest.current,
    chat: (key) => latest.current.chats.find((each) => each.key === key),
    line: (key, role, body, after) => {
      count.current += 1;
      const id = `${role}-${String(count.current)}`;
      update((current) => placed(said(current, key, { id, role, body, cites: [] }), key, after));
      return id;
    },
  };
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
  else if (reply.answered) store.line(key, 'ai', reply.body);
  else store.line(key, 'failed', reply.words);
}

/** The tab's first question, its answer, then the page it was given before it started. */
async function startWith(
  client: OperationsClient,
  store: Store,
  opening: Opening,
  report: (key: string, sent: Sent) => Promise<boolean>,
): Promise<string | null> {
  const { chat, body, subject, scope } = opening;
  const { title, page } = store.chat(chat.key) ?? chat;
  const settled = settle(
    await client.mutate('conversation.start', { body, title, subject: subject.label, scope }),
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
  store.update((current) => started(current, chat.key, id));
  replied(store, chat.key, settled.kind === 'ok' ? settled.value.reply : undefined);
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
  const start = (chat: Chat, body: string, on: Store): Promise<string | null> =>
    startWith(props.client, on, { chat, body, subject, scope: scope() }, report);
  const send = async (key: string, body: string): Promise<void> => {
    const chat = store.chat(key);
    if (chat === undefined) return;
    const question = store.line(key, 'user', body);
    const on: Store = { ...store, line: (k, role, words) => store.line(k, role, words, question) };
    let known = chat.conversationId;
    if (known === null) {
      // Queued behind the tab's last start: joins what it made, or starts
      // itself only once that start is refused.
      let asked = false;
      const before = starts.current.get(key) ?? Promise.resolve(null);
      const turn = before.then(async (id) => {
        if (id !== null) return id;
        asked = true;
        return await start(chat, body, on);
      });
      starts.current.set(key, turn);
      known = await turn;
      if (asked || known === null) return;
    }
    const settled = settle(
      await props.client.mutate('conversation.message', { conversationId: known, body }),
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
} {
  const written = (key: string, write: (conversationId: string) => Sent): void => {
    const turn = sender.starts.get(key)?.then(async (id) => {
      if (id !== null) await sender.report(key, write(id));
      return id;
    });
    if (turn !== undefined) sender.starts.set(key, turn);
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
  };
}

/** The tab's allowance line, read again as each of its answers settles. */
function allowanceFor(client: OperationsClient, chat: Chat | undefined): ReactElement {
  // Every message but the person's own is a settled answer: a reply, a note or a failure.
  const settled = chat?.messages.filter((message) => message.role !== 'user').length ?? 0;
  const conversationId = chat?.conversationId ?? null;
  return <AllowanceLine client={client} conversationId={conversationId} settled={settled} />;
}

export function AssistantView(props: AssistantViewProps): ReactElement {
  const store = useStore();
  const { state, update } = store;
  useEffect(() => {
    const made = props.entry === null ? null : entryFor(props.entry);
    if (made !== null) update((current) => ask(current, made));
    // The store's `update` is a fresh function each render and changes nothing
    // the ask reads; only a new entry is a new ask.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [props.entry]);
  const subject = subjectFor({ route: props.route, ...state.scope });
  const sender = useSender(props, store, subject);
  const writes = useWrites(props, store, sender);
  const chat = state.chats.find((each) => each.key === state.selected);
  const opened = chat?.conversationId ?? null;
  return (
    <AssistantPanel
      subject={subject}
      chats={state.chats}
      selected={state.selected}
      offer={modelOffer(subject, CATALOGUE, null)}
      address={
        opened === null ? null : pathTo('agency:agent-conversation', { conversation: opened })
      }
      citation={state.citation}
      allowance={allowanceFor(props.client, chat)}
      draft={state.draft}
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
      onModel={(key, model) => {
        update((current) => chooseModel(current, key, model));
      }}
      onAddPage={writes.addPage}
      onSend={sender.send}
      onClose={props.onClose}
    />
  );
}
