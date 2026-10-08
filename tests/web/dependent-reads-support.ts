// SPDX-License-Identifier: AGPL-3.0-only
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { task, TASK_ID } from './task-page-stub.tsx';

export const KEY = 'Proj-Verity-Pacing';
export const DENIED = { refused: true, code: 'SCOPE_NOT_GRANTED', names: ['task'], fixes: [] };
type Sent = { readonly path: string; readonly body: Record<string, unknown> };
type State = {
  sent: Sent[];
  streams: Map<ReadableStreamDefaultController<Uint8Array>, readonly string[]>;
  held: (() => void)[];
  hold: boolean;
  holdPeople: boolean;
  permitPerson: boolean;
  peopleOutage: boolean;
  fail: 'denied' | 'outage' | null;
  rank: number;
  waiting: number;
  extra: boolean;
  loseCreate: boolean;
  member: boolean;
};
function value(state: State) {
  const result = task({
    rank: { number: state.rank, score: 504, calc: 'Derived from admitted work' },
  });
  if (!state.member) Reflect.deleteProperty(result, 'client');
  return result;
}
function todosReply(state: State): Response {
  const todo = {
    ...value(state),
    assignee: { personId: 'p-ada', name: 'Ada' },
    tags: [],
    waitingComments: state.waiting,
    category: null,
    whoseMove: 'Team',
  };
  const other = {
    ...todo,
    id: 'other',
    key: 'Proj-Other',
    title: 'Other permitted task',
    waitingComments: 1,
  };
  return Response.json({ ok: true, todos: state.extra ? [todo, other] : [todo] });
}
function checkedReply(state: State, path: string): Response {
  if (state.fail === 'outage') throw new TypeError('The checked read is unavailable');
  if (state.fail === 'denied') return Response.json(DENIED, { status: 403 });
  return path === '/task/read'
    ? Response.json({ ok: true, task: value(state) })
    : todosReply(state);
}
function liveReply(state: State, url: URL, signal: AbortSignal | null | undefined): Response {
  const topics = url.searchParams.getAll('topic');
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        state.streams.set(controller, topics);
        signal?.addEventListener('abort', () => {
          state.streams.delete(controller);
        });
      },
      cancel() {
        /* The abort retires this stream before a replacement joins. */
      },
    }),
  );
}
function ordinaryReply(state: State, path: string): Response {
  if (path === '/person/list') {
    if (state.peopleOutage) throw new TypeError('The permitted vocabulary is unavailable');
    return Response.json({
      ok: true,
      persons: state.permitPerson ? [{ personId: 'p-ada', name: 'Ada' }] : [],
    });
  }
  if (path === '/client/list')
    return Response.json({ ok: true, clients: [{ clientId: 'c-alpha', name: 'Alpha' }] });
  if (path === '/task/board') return Response.json({ ok: true, tasks: [] });
  if (path === '/task/queue')
    return Response.json({ ok: true, queue: [], alerts: [], outages: [] });
  if (path === '/task/create') {
    if (state.loseCreate) {
      state.loseCreate = false;
      throw new TypeError('The create answer was lost');
    }
    return Response.json({ ok: true, recordId: 'child-one', revision: 1 });
  }
  return Response.json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, { status: 404 });
}
function reply(
  state: State,
  input: RequestInfo | URL,
  init?: RequestInit,
): Response | Promise<Response> {
  const url = new URL(String(input), 'http://local');
  if (url.pathname.endsWith('/live')) return liveReply(state, url, init?.signal);
  const path = url.pathname.replace(/^.*?(\/[a-z]+\/[a-z_]+)$/u, '$1');
  const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'];
  state.sent.push({ path, body });
  if (path === '/person/list' && state.holdPeople) {
    state.holdPeople = false;
    return new Promise<Response>((resolve, reject) => {
      state.held.push(() => {
        try {
          resolve(ordinaryReply(state, path));
        } catch (error) {
          reject(error);
        }
      });
    });
  }
  if (path !== '/task/read' && path !== '/task/todos') return ordinaryReply(state, path);
  if (!state.hold) return checkedReply(state, path);
  state.hold = false;
  return new Promise<Response>((resolve) => {
    state.held.push(() =>
      resolve(
        path === '/task/read' ? Response.json({ ok: true, task: value(state) }) : todosReply(state),
      ),
    );
  });
}
function frame(state: State, name: string, topic: string): void {
  for (const [controller, topics] of state.streams) {
    if (topics.includes(topic))
      controller.enqueue(new TextEncoder().encode(`event: ${name}\ndata: ${topic}\n\n`));
  }
}
function freshState(): State {
  return {
    sent: [],
    streams: new Map(),
    held: [],
    hold: false,
    holdPeople: false,
    permitPerson: false,
    peopleOutage: false,
    fail: null,
    rank: 4,
    waiting: 2,
    extra: false,
    loseCreate: false,
    member: true,
  };
}

export function dependentServer() {
  const state = freshState();
  const fetch: typeof globalThis.fetch = (input, init) =>
    Promise.resolve().then(() => reply(state, input, init));
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return {
    client,
    sent: state.sent,
    value: () => value(state),
    delegate: () => {
      state.member = false;
    },
    requests: (path: string) => state.sent.filter((request) => request.path === path),
    streams: () => [...state.streams.values()],
    change: () => {
      state.rank = 1;
      state.waiting = 5;
      state.extra = true;
    },
    fail: (next: State['fail']) => {
      state.fail = next;
    },
    permitPerson: () => {
      state.permitPerson = true;
    },
    peopleOutage: (failed: boolean) => {
      state.peopleOutage = failed;
    },
    holdPeople: () => {
      state.holdPeople = true;
    },
    hold: () => {
      state.hold = true;
    },
    release: () => {
      state.held.shift()?.();
    },
    loseCreate: () => {
      state.loseCreate = true;
    },
    frame: (name = 'invalidate', topic = 'board') => {
      frame(state, name, topic);
    },
    taskFrame: () => {
      frame(state, 'invalidate', `task:${TASK_ID}`);
    },
  };
}
