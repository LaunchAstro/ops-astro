// SPDX-License-Identifier: AGPL-3.0-only
//
// The assistant drawer over a stand-in API that keeps a register as the
// server's does: a repeated operation id answers what its first attempt
// committed. It also keeps each conversation as the server would (its title,
// model, page and transcript, with message ids), so `conversation.read` and
// `conversation.list` answer what was committed, and a question and its answer
// can commit in separate steps, as the real exchange does
// (`conversation-exchange.ts`). Shared by the resend suites
// (`apps/web/src/assistant/resend.ts`).

import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TASK, type Body, type Sent } from './replay-drawer.tsx';

/**
 * What the stand-in does with a write: answer it, lose its answer, hold it,
 * hold it and then lose its answer, refuse it, or commit the question, hold,
 * then commit the answer and lose it; a late write reaches the server only on release.
 */
export type Turn = 'answer' | 'drop' | 'hold' | 'hold-drop' | 'late' | 'refuse' | 'split-drop';

type Page = { readonly address: string; readonly shows: string } | null;

/** One conversation as the stand-in server holds it. */
export interface Held {
  readonly id: string;
  title: string;
  model: string | null;
  page: Page;
  readonly scope: { readonly kind: 'task'; readonly id: string } | null;
  readonly messages: { readonly id: string; readonly role: 'person' | 'agent'; body: string }[];
}

const answer = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const refusal = (): Response =>
  answer({ refused: true, code: 'MODEL_UNAVAILABLE', names: [], fixes: [] }, 409);

const NOT_FOUND = (): Response =>
  answer({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);

const uuid = (lead: string, n: number): string =>
  `${lead}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** The task revision each read answers, the reply each committed question carries, and the models. */
export interface Shape {
  readonly revision: () => number;
  readonly reply: (question: string) => Readonly<Record<string, unknown>>;
  readonly models: () => readonly { readonly id: string; readonly label?: string }[];
}

const PLAIN: Shape = {
  revision: () => 7,
  reply: () => ({ answered: true, body: 'An answer.', cites: [] }),
  models: () => [{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-m3' }],
};

const waiting = (into: (() => void)[]): Promise<void> =>
  new Promise<void>((release) => {
    into.push(release);
  });

/** `conversation.read`'s answer for one held conversation. */
const readOf = (one: Held) => ({
  ok: true,
  conversation: {
    id: one.id,
    address: `/agent/conversations/${one.id}`,
    title: one.title,
    subject: null,
    scope: one.scope,
    page: one.page,
    createdAt: '2026-10-18T00:00:00.000Z',
    lastActivityAt: '2026-10-18T00:00:00.000Z',
    bodyPurgedAt: null,
  },
  messages: one.messages.map((each) => ({ ...each, createdAt: '2026-10-18T00:00:00.000Z' })),
  wrapUp: null,
  wrapUpHistory: [],
});

/** The stand-in's state, shared between its responders and the test. */
interface Stage {
  readonly shape: Shape;
  readonly register: Map<string, Response>;
  readonly sent: Sent[];
  readonly bodies: Body[];
  readonly committed: string[];
  readonly held: (() => void)[];
  readonly heldReads: (() => void)[];
  readonly server: Map<string, Held>;
  readonly queues: {
    readonly first: Map<string, Turn[]>;
    readonly replay: Map<string, ('answer' | 'refuse')[]>;
  };
  ids: number;
  readsHeld: number;
}

const listOf = (stage: Stage) => ({
  ok: true,
  conversations: [...stage.server.values()].map((one) => ({
    id: one.id,
    address: `/agent/conversations/${one.id}`,
    title: one.title,
    lastActivityAt: '2026-10-18T00:00:00.000Z',
    bodyPurged: false,
  })),
});

/** How the stand-in answers a read. */
async function read(stage: Stage, command: string, body: Record<string, unknown>) {
  if (stage.readsHeld > 0 && command === 'conversation.read') {
    stage.readsHeld -= 1;
    await waiting(stage.heldReads);
  }
  if (command === 'conversation.models') return answer({ models: stage.shape.models() });
  if (command === 'conversation.list') return answer(listOf(stage));
  if (command === 'conversation.read') {
    const one = stage.server.get(String(body['conversationId']));
    return one === undefined ? NOT_FOUND() : answer(readOf(one));
  }
  if (command === 'task.read') {
    // A negative revision stands for a read that failed.
    const at = stage.shape.revision();
    return at < 0 ? NOT_FOUND() : answer({ task: { ...TASK, revision: at } });
  }
  return NOT_FOUND();
}

/** A started conversation as the server keeps it, from the start's body. */
function begun(stage: Stage, body: Record<string, unknown>): Held {
  const page = (body['page'] as Page | undefined) ?? null;
  const scope = (body['scope'] as Held['scope'] | undefined) ?? null;
  const title = typeof body['title'] === 'string' ? body['title'] : 'Untitled';
  const model = typeof body['model'] === 'string' ? body['model'] : null;
  const one = { id: uuid('c', ++stage.ids), title, model, page, scope, messages: [] };
  stage.server.set(one.id, one);
  return one;
}

/** The question committed, and how to commit its answer: a reply and its message id. */
function ask(stage: Stage, command: string, body: Record<string, unknown>) {
  const question = String(body['body']);
  const conversation =
    command === 'conversation.start'
      ? begun(stage, body)
      : stage.server.get(String(body['conversationId']));
  if (conversation === undefined) return null;
  const messageId = uuid('d', ++stage.ids);
  conversation.messages.push({ id: messageId, role: 'person', body: question });
  const made = stage.shape.reply(question);
  const reply = made['answered'] === true ? { messageId: uuid('e', ++stage.ids), ...made } : made;
  const commit = (): void => {
    if (reply['answered'] !== true) return;
    const id = String(reply['messageId']);
    conversation.messages.push({ id, role: 'agent', body: String(reply['body']) });
  };
  return { conversationId: conversation.id, messageId, reply, commit };
}

/** A write other than a question, applied to the conversation it names. */
function wrote(stage: Stage, command: string, body: Record<string, unknown>): void {
  const one = stage.server.get(String(body['conversationId']));
  if (one === undefined) return;
  if (command === 'conversation.rename') one.title = String(body['title']);
  if (command === 'conversation.set_model') one.model = String(body['model']);
  if (command === 'conversation.set_scope') one.page = body['page'] as Page;
}

/** A first attempt committed: the answer it applied, and what is left to commit after a hold. */
function applied(stage: Stage, command: string, body: Record<string, unknown>, turn: Turn) {
  stage.committed.push(command);
  const asked =
    command === 'conversation.start' || command === 'conversation.message'
      ? ask(stage, command, body)
      : null;
  if (asked === null) wrote(stage, command, body);
  else if (turn !== 'split-drop') asked.commit();
  const conversationId = asked?.conversationId ?? body['conversationId'] ?? '';
  const response = answer({
    recordId: conversationId,
    revision: 1,
    detail: { conversationId, ...(asked && { messageId: asked.messageId }) },
    ...(asked && { reply: asked.reply }),
  });
  return { response, later: turn === 'split-drop' ? asked?.commit : undefined };
}

/** How the stand-in answers a write, by its turns. */
async function mutate(stage: Stage, command: string, body: Record<string, unknown>) {
  const operationId = String(body['operationId']);
  stage.sent.push({ command, operationId });
  stage.bodies.push({ command, body });
  const kept = stage.register.get(operationId);
  if (kept !== undefined) {
    return stage.queues.replay.get(command)?.shift() === 'refuse' ? refusal() : kept.clone();
  }
  const turn = stage.queues.first.get(command)?.shift() ?? 'answer';
  if (turn === 'refuse') {
    stage.register.set(operationId, refusal());
    return refusal();
  }
  if (turn === 'late') await waiting(stage.held);
  const { response, later } = applied(stage, command, body, turn);
  stage.register.set(operationId, response.clone());
  if (turn === 'hold' || turn === 'hold-drop' || turn === 'split-drop') {
    await waiting(stage.held);
  }
  later?.();
  if (turn === 'drop' || turn === 'hold-drop' || turn === 'split-drop') {
    throw new TypeError('The connection closed before the answer.');
  }
  return response;
}

/**
 * The stand-in API. A new operation id takes the next of its command's
 * `first` turns (answer by default) and, unless refused, is committed and its
 * answer kept; a repeat takes the next `replay` turn, answering what was kept
 * by default. A held write is committed and answers on `release()`; a read
 * held by `holdReads()` answers on `releaseRead()`.
 */
export function standIn(
  first: Readonly<Record<string, Turn[]>> = {},
  replay: Readonly<Record<string, ('answer' | 'refuse')[]>> = {},
  given: Partial<Shape> = {},
) {
  const stage: Stage = {
    shape: { ...PLAIN, ...given },
    register: new Map(),
    sent: [],
    bodies: [],
    committed: [],
    held: [],
    heldReads: [],
    server: new Map(),
    queues: {
      first: new Map(Object.entries(first).map(([k, v]) => [k, [...v]])),
      replay: new Map(Object.entries(replay).map(([k, v]) => [k, [...v]])),
    },
    ids: 0,
    readsHeld: 0,
  };
  const fetch = (async (url: string, init?: RequestInit) => {
    const command = String(url).split('/').slice(-2).join('.');
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return typeof body['operationId'] === 'string'
      ? await mutate(stage, command, body)
      : await read(stage, command, body);
  }) as typeof globalThis.fetch;
  const clientFor = (businessKey: string): OperationsClient =>
    new OperationsClient({ origin: '', businessKey, signedIn: true, fetch });
  const { sent, bodies, committed, server } = stage;
  return {
    client: clientFor('alpha'),
    clientFor,
    sent,
    bodies,
    committed,
    server,
    release: () => stage.held.shift()?.(),
    holdReads: (count = 1) => {
      stage.readsHeld += count;
    },
    releaseRead: () => stage.heldReads.shift()?.(),
  };
}

export type StandIn = ReturnType<typeof standIn>;

export * from './replay-drawer.tsx';
