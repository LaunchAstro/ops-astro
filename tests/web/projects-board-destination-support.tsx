// SPDX-License-Identifier: AGPL-3.0-only
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { json, refused } from './work-log-stand-in.tsx';
export const SUMMIT_TASK = {
  id: '00000000-0000-4000-8000-000000000001',
  key: 'T-1',
  title: 'Summit intake form',
  state: { id: 's-1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 1,
  rank: { number: null, score: null, calc: 'not ranked' },
  stage: null,
  clientSet: true,
  client: { clientId: 'c-summit', name: 'Summit Allied' },
  actualMinutes: 0,
  estimateMinutes: null,
  category: null,
  pageLink: null,
  statePosition: 1,
  waitReason: null,
  awaitingDecision: false,
};

/** A dock panel's Projects at `address`; one client across renders, so a re-render walks the same instance. */
export const panel = (client: OperationsClient, address: string) => (
  <Projects client={client} grantKey="alpha:owner" navigate={() => {}} address={address} inPanel />
);

export const clientFor = (fetch: typeof globalThis.fetch): OperationsClient =>
  new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });

export const scopedPerson = 'aaaaaaaa-1111-4111-8111-111111111111';
export const scopedClient = 'bbbbbbbb-2222-4222-8222-222222222222';
export const boardA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const boardB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export function destinationTask(destination: string | null, index: number) {
  return {
    ...SUMMIT_TASK,
    id: `00000000-0000-4000-8000-00000000000${String(index + 1)}`,
    key: `Scope-${String(index + 1)}`,
    title: `Scoped work ${String(index + 1)}`,
    board: destination,
    assignee: { personId: scopedPerson, name: 'Current teammate' },
    client: { clientId: scopedClient, name: 'Current client' },
    due: '2020-01-01',
    priority: 1,
    rank: { number: index + 7, calc: 'reader pool', score: 1 },
    todo: {
      tags: [{ id: 'tag-1', name: 'urgent' }],
      waitingComments: index + 1,
      whoseMove: 'Review',
    },
  };
}

interface DestinationState {
  controller?: ReadableStreamDefaultController<Uint8Array>;
  revoked: boolean;
  peopleDenied: boolean;
  vocabHeld: boolean;
  outage: boolean;
  outageDependency: string;
  boardOutage: boolean;
  vocabAnswers: (() => void)[];
  mutations: unknown[];
  hold: ((answer: Response) => void) | undefined;
  asked: unknown[];
  tasks: ReturnType<typeof destinationTask>[];
}
function answerVocabulary(state: DestinationState, answer: () => Response): Promise<Response> {
  return state.vocabHeld
    ? new Promise<Response>((resolve) => {
        state.vocabAnswers.push(() => {
          resolve(answer());
        });
      })
    : Promise.resolve(answer());
}
function destinationVocabulary(state: DestinationState, at: string): Promise<Response> | undefined {
  if (
    state.outage &&
    ((at.endsWith('/person/list') && state.outageDependency !== 'client') ||
      (at.endsWith('/client/list') && state.outageDependency !== 'person'))
  )
    return Promise.resolve(new Response(null, { status: 503 }));
  if (at.endsWith('/person/list')) {
    if (state.peopleDenied)
      return Promise.resolve(json(refused('SCOPE_NOT_GRANTED', ['person']), 403));
    const answer = () =>
      json({
        ok: true,
        persons: state.revoked ? [] : [{ personId: scopedPerson, name: 'Current teammate' }],
      });
    return answerVocabulary(state, answer);
  }
  if (at.endsWith('/client/list')) {
    const answer = () =>
      json({
        ok: true,
        clients: state.revoked ? [] : [{ clientId: scopedClient, name: 'Current client' }],
      });
    return answerVocabulary(state, answer);
  }
  return undefined;
}
function destinationBoard(
  state: DestinationState,
  init: RequestInit | undefined,
): Promise<Response> {
  const body: Record<string, unknown> = JSON.parse(
    typeof init?.body === 'string' ? init.body : '{}',
  );
  state.asked.push(body);
  if (state.boardOutage) return Promise.resolve(new Response(null, { status: 503 }));
  if (state.hold !== undefined)
    return new Promise<Response>((resolve) => {
      state.hold = resolve;
    });
  return Promise.resolve(
    json({
      ok: true,
      tasks: state.revoked
        ? []
        : state.tasks.filter(
            (task) => body['mode'] === 'aggregate' || task.board === body['board'],
          ),
      changedAt: null,
      viewer: 'different-viewer',
      owed: 0,
    }),
  );
}
function destinationFetch(
  state: DestinationState,
  url: Parameters<typeof globalThis.fetch>[0],
  init: RequestInit | undefined,
): Promise<Response> {
  const at = String(url);
  if (at.includes('/live?'))
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start: (value) => {
            state.controller = value;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    );
  const vocabulary = destinationVocabulary(state, at);
  if (vocabulary !== undefined) return vocabulary;
  if (at.endsWith('/task/board')) return destinationBoard(state, init);
  if (at.endsWith('/task/update')) state.mutations.push(init?.body);
  return new Promise<Response>(() => {});
}
function destinationState(): DestinationState {
  return {
    revoked: false,
    peopleDenied: false,
    vocabHeld: false,
    outage: false,
    outageDependency: 'vocabulary',
    boardOutage: false,
    vocabAnswers: [],
    mutations: [],
    hold: undefined,
    asked: [],
    tasks: [boardA, boardB, null].map((destination, index) => destinationTask(destination, index)),
  };
}
export function destinationServer() {
  const state = destinationState();
  const client = clientFor((url, init) => destinationFetch(state, url, init));
  return {
    client,
    asked: state.asked,
    tasks: state.tasks,
    mutations: state.mutations,
    denyPeople: (value = true) => {
      state.peopleDenied = value;
    },
    outage: (value: boolean, dependency = 'vocabulary') => {
      if (dependency === 'rows') state.boardOutage = value;
      else {
        state.outage = value;
        state.outageDependency = dependency;
      }
    },
    holdVocabulary: () => {
      state.vocabHeld = true;
    },
    releaseVocabulary: () => {
      state.vocabHeld = false;
      for (const answer of state.vocabAnswers.splice(0)) answer();
    },
    invalidate: () =>
      state.controller?.enqueue(new TextEncoder().encode('event: invalidate\ndata: board\n\n')),
    revoke: () => {
      state.revoked = true;
    },
    holdNext: () => {
      state.hold = () => {};
    },
    release: () => {
      const resolve = state.hold;
      state.hold = undefined;
      resolve?.(
        json({
          ok: true,
          tasks: state.tasks,
          changedAt: null,
          viewer: 'different-viewer',
          owed: 0,
        }),
      );
    },
  };
}
