// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11: the drawer on the real conversation commands.
//
// A tab is started by its first question (`conversation.start`) and each later
// question joins it (`conversation.message`). A rename or a page chosen before
// that first question is held in the tab and goes with the start: the title in
// the start itself, the page by `conversation.set_scope` straight after it.
// Once started, a rename and a page go to the conversation straight away.
//
// **One start per tab.** A second question asked while the first is still
// starting waits for that start and joins the conversation it made, so a
// quick second press never opens a second conversation.
//
// **Nothing about a client's material is sent** (owner line 72): the drawer
// refuses the question itself while the offer is empty with a reason
// (`modelOffer`), so no command leaves for it. The model picker holds its
// choice in the tab until conversations carry a model (CS-7.30, on AW-01's
// seam); the catalogue is empty until the business's price book is readable
// here, so the picker offers nothing and the choice is not sent.
//
// The agent does not answer yet: the exchange runs on AW-01's model seam. A
// kept question says so in plain words.

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { AssistantPanel, type AssistantMessage, type AssistantPage } from '@launchastro/ui';
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
import type { CallResult, CommandOutcome, OperationsClient } from '../operations/client.ts';
import { settle } from '../records/use-command.ts';
import { ROUTES, type RouteId } from '../routes.ts';

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
  readonly onClose: () => void;
}

type Move = (state: AssistantState) => AssistantState;

interface Store {
  readonly state: AssistantState;
  readonly update: (move: Move) => void;
  /** The state as the last move left it, for a step that resumes after a wait. */
  readonly now: () => AssistantState;
  readonly chat: (key: string) => Chat | undefined;
  readonly line: (key: string, role: AssistantMessage['role'], body: string) => void;
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
    line: (key, role, body) => {
      count.current += 1;
      const id = `${role}-${String(count.current)}`;
      update((current) => said(current, key, { id, role, body, cites: [] }));
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

/** The tab's first question, then the page it was given before it started. */
async function startWith(
  client: OperationsClient,
  store: Store,
  opening: Opening,
  report: (key: string, sent: Sent) => Promise<boolean>,
): Promise<string | null> {
  const { chat, body, subject, scope } = opening;
  const settled = settle(
    await client.mutate('conversation.start', {
      body,
      title: chat.title,
      subject: subject.label,
      scope,
    }),
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
  const page = store.chat(chat.key)?.page ?? null;
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
  const start = (chat: Chat, body: string): Promise<string | null> =>
    startWith(props.client, store, { chat, body, subject, scope: scope() }, report);
  const send = async (key: string, body: string): Promise<void> => {
    const chat = store.chat(key);
    if (chat === undefined) return;
    store.line(key, 'user', body);
    const pending = starts.current.get(key);
    const known = chat.conversationId ?? (pending === undefined ? null : await pending);
    let kept: boolean;
    if (known === null) {
      const starting = start(chat, body);
      starts.current.set(key, starting);
      kept = (await starting) !== null;
      if (!kept) starts.current.delete(key);
    } else {
      kept = await report(
        key,
        props.client.mutate('conversation.message', { conversationId: known, body }),
      );
    }
    if (kept) store.line(key, 'note', KEPT);
  };
  return { report, send };
}

const setScope = (client: OperationsClient, conversationId: string, page: AssistantPage): Sent =>
  client.mutate('conversation.set_scope', { conversationId, page });

/** A rename and a page: held in the tab, and sent at once when it has started. */
function useWrites(
  props: AssistantViewProps,
  store: Store,
  report: (key: string, sent: Sent) => Promise<boolean>,
): {
  readonly rename: (key: string, title: string) => void;
  readonly addPage: (key: string) => void;
} {
  const written = (key: string, write: (conversationId: string) => Sent): void => {
    const id = store.chat(key)?.conversationId ?? null;
    if (id !== null) void report(key, write(id));
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
  const writes = useWrites(props, store, sender.report);
  return (
    <AssistantPanel
      subject={subject}
      chats={state.chats}
      selected={state.selected}
      offer={modelOffer(subject, CATALOGUE, null)}
      citation={state.citation}
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
      onSend={(key, text) => {
        void sender.send(key, text);
      }}
      onClose={props.onClose}
    />
  );
}
