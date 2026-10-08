// SPDX-License-Identifier: AGPL-3.0-only
import { act, useState, type ReactElement } from 'react';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { mount } from '../surfaces/mount.tsx';
import { draftReply, draftTab, type Sent } from './projects-draft-app-support.tsx';
import { task, tick } from './task-page-stub.tsx';

const noMove = (_path: string): void => {};
export const A = '11111111-1111-4111-8111-111111111111';
export const B = '22222222-2222-4222-8222-222222222222';
export const START = '2026-10-09T01:00:00.000Z';
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

interface Model {
  readonly sent: Sent[];
  readonly replies: Map<string, unknown>;
  readonly finished: string[];
  running: string | null;
  lostStops: number;
  lostStarts: number;
  denied: boolean;
  unavailable: boolean;
  refuseStop: boolean;
}
function read(model: Model, id: string): Response {
  return json({
    ok: true,
    task: task({
      id,
      key: id === A ? 'Timer-A' : 'Timer-B',
      title: id === A ? 'Alpha work' : 'Beta work',
      time: {
        entries: model.finished.includes(id)
          ? [
              {
                id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                minutes: 1,
                startedAt: START,
                endedAt: START,
                note: '',
                adHoc: false,
                source: 'timer',
              },
            ]
          : [],
        running:
          model.running === id
            ? { entryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', startedAt: START }
            : null,
        totalMinutes: model.finished.includes(id) ? 1 : 0,
      },
    }),
  });
}
function command(model: Model, request: Sent): Promise<Response> {
  const id = String(request.body['taskId']);
  const operation = String(request.body['operationId']);
  const prior = model.replies.get(operation);
  if (prior !== undefined) return Promise.resolve(json(prior));
  if (request.path === '/time/stop' && model.refuseStop)
    return Promise.resolve(
      json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403),
    );
  if (request.path === '/time/start') model.running = id;
  else {
    model.running = null;
    model.finished.push(id);
  }
  const answer = {
    recordId: null,
    revision: null,
    detail:
      request.path === '/time/start'
        ? { entryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', startedAt: START }
        : { entryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', minutes: 1 },
  };
  model.replies.set(operation, answer);
  if (request.path === '/time/stop' && model.lostStops-- > 0)
    return Promise.reject(new TypeError('lost stop answer'));
  if (request.path === '/time/start' && model.lostStarts-- > 0)
    return Promise.reject(new TypeError('lost start answer'));
  return Promise.resolve(json(answer));
}
function boardItem() {
  return Object.assign({}, task({ id: A, key: 'Timer-A', title: 'Alpha work', time: null }), {
    actualMinutes: 0,
    estimateMinutes: null,
    statePosition: null,
    waitReason: null,
    awaitingDecision: false,
    agent: null,
    myAgents: [],
    comments: { client: 0, mentions: 0, latest: null },
  });
}
function fetchFrom(model: Model): typeof globalThis.fetch {
  return (url, init) => {
    const request = {
      path: String(url).replace(/^.*?(\/[a-z]+\/[a-z_]+)$/u, '$1'),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    };
    model.sent.push(request);
    if (['/time/start', '/time/stop'].includes(request.path)) return command(model, request);
    if (request.path === '/task/board')
      return Promise.resolve(json({ ok: true, tasks: [boardItem()], viewer: null }));
    if (request.path === '/task/read') {
      if (model.unavailable) return Promise.resolve(json({}, 503));
      if (model.denied)
        return Promise.resolve(
          json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404),
        );
      return Promise.resolve(
        read(model, ['Timer-A', A].includes(String(request.body['recordId'])) ? A : B),
      );
    }
    if (request.path === '/task/search')
      return Promise.resolve(
        json({ ok: true, hits: [{ key: 'Timer-A', title: 'Alpha work', client: null }] }),
      );
    return Promise.resolve(draftReply(request));
  };
}
export function timerWorld() {
  const model: Model = {
    sent: [],
    replies: new Map(),
    finished: [],
    running: null,
    lostStops: 0,
    lostStarts: 0,
    denied: false,
    unavailable: false,
    refuseStop: false,
  };
  return {
    fetch: fetchFrom(model),
    sent: model.sent,
    finished: model.finished,
    writes: () => model.sent.filter((one) => ['/time/start', '/time/stop'].includes(one.path)),
    loseStop: () => {
      model.lostStops = 1;
    },
    loseStart: () => {
      model.lostStarts = 1;
    },
    deny: () => {
      model.denied = true;
    },
    outage: () => {
      model.unavailable = true;
    },
    refuseStop: (value: boolean) => {
      model.refuseStop = value;
    },
  };
}

export async function timerApp(world: ReturnType<typeof timerWorld>, initial = '/task/Timer-A') {
  const storage = draftTab();
  const sessions = new SessionStore(storage);
  let move = noMove;
  function Entry(): ReactElement {
    const [path, navigate] = useState(initial);
    move = navigate;
    return (
      <App
        path={path}
        navigate={navigate}
        sessions={sessions}
        gotrueUrl="http://gotrue.test"
        apiOrigin=""
        fetch={world.fetch}
        storage={storage}
      />
    );
  }
  const view = await mount(<Entry />);
  await tick();
  return {
    view,
    storage,
    navigate: async (path: string) => {
      await act(() => move(path));
      await tick();
    },
  };
}
