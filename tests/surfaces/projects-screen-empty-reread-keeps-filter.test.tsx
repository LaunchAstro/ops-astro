// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects screen under a live reread that answers no tasks (#902). A
// filter the person has on stays on, drawn and removable, when the board's
// last row goes and when another person's row arrives after it: the board
// shows nothing until the person drops the filter.

import { act } from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from './mount.tsx';

beforeEach(() => {
  window.history.replaceState(null, '', '/projects/?f=assignee%3Ap-ben');
});
afterEach(() => {
  window.history.replaceState(null, '', '/');
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const BEN = { personId: 'p-ben', name: 'Ben' };
const ANA = { personId: 'p-ana', name: 'Ana' };

const task = (id: string, assignee: typeof BEN) => ({
  id,
  key: id,
  title: `Task ${id}`,
  state: { id: 's-1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee,
  due: null,
  priority: null,
  completedAt: null,
  revision: 1,
  rank: { number: null, score: null, calc: 'not ranked: missing ease' },
  stage: null,
  clientSet: false,
  statePosition: 1000,
  awaitingDecision: false,
  estimateMinutes: null,
  actualMinutes: 0,
  pageLink: null,
});

/** Board reads answer in turn; the tab's live stream is the test's to write. */
function server(answers: readonly (readonly ReturnType<typeof task>[])[]) {
  let reads = 0;
  const encoder = new TextEncoder();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const fetch = ((url: string) => {
    const at = String(url);
    if (/\/live(\?|$)/u.test(at)) {
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          streams.push(controller);
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }
    if (at.endsWith('/inbox/read')) return Promise.resolve(json({ ok: true, inbox: [] }));
    if (at.endsWith('/inbox/count')) return Promise.resolve(json({ ok: true, owed: 0 }));
    if (at.endsWith('/task/board')) {
      const tasks = answers[Math.min(reads, answers.length - 1)] ?? [];
      reads += 1;
      return Promise.resolve(json({ ok: true, tasks, changedAt: null, viewer: null, withheld: 0 }));
    }
    if (at.endsWith('person/list')) return Promise.resolve(json({ ok: true, persons: [BEN, ANA] }));
    return Promise.resolve(json({ ok: true, clients: [] }));
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    reads: () => reads,
    invalidate: () => {
      for (const each of streams)
        each.enqueue(encoder.encode('event: invalidate\ndata: board\n\n'));
    },
  };
}

const settleAll = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- each pass flushes the next hop
    await settle();
  }
};

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

async function reread(api: ReturnType<typeof server>): Promise<void> {
  const before = api.reads();
  api.invalidate();
  for (let i = 0; i < 50 && api.reads() === before; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- wait for the live reread to be asked
    await act(pause);
  }
  expect(api.reads(), 'the live invalidation reread the board').toBe(before + 1);
  await settleAll();
}

it('a live reread answering no tasks, then only Ana’s, keeps Ben’s filter drawn and removable', async () => {
  const api = server([[task('ben-1', BEN)], [], [task('ana-1', ANA)]]);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 });
  const view = await mount(
    <Projects client={api.client} grantKey="alpha:mia" navigate={() => {}} />,
  );
  await settleAll();
  const rows = () => view.all('tr[data-row]').map((one) => (one as HTMLElement).dataset['row']);
  const benTag = () =>
    view.all('.cbd__tag').find((tag) => (tag.textContent ?? '').includes('Ben')) ?? null;
  expect(rows()).toEqual(['ben-1']);
  expect(benTag()).not.toBeNull();

  await reread(api);
  expect(benTag(), 'the empty reread dropped Ben’s filter from view').not.toBeNull();
  expect(benTag()?.querySelector('.cbd__tagx'), 'Ben’s filter cannot be removed').not.toBeNull();

  await reread(api);
  expect(rows(), 'Ana’s task shows while Ben’s filter is still on').toEqual([]);
  expect(benTag(), 'Ben’s filter vanished once Ana’s row arrived').not.toBeNull();

  // eslint-disable-next-line require-await -- act's async form flushes the event's effects
  await act(async () => {
    (benTag()?.querySelector('.cbd__tagx') as HTMLElement | null)?.click();
  });
  await settleAll();
  expect(rows(), 'dropping Ben’s filter shows Ana’s task').toEqual(['ana-1']);
});

it('with no filter on, a live reread answering no tasks says the page’s empty words', async () => {
  window.history.replaceState(null, '', '/projects/?f=');
  const api = server([[task('ana-1', ANA)], []]);
  const view = await mount(
    <Projects client={api.client} grantKey="alpha:mia" navigate={() => {}} />,
  );
  await settleAll();
  expect(view.find('tr[data-row="ana-1"]')).not.toBeNull();
  await reread(api);
  expect(view.text()).toContain('No tasks on this board yet.');
  expect(view.find('[data-board]'), 'an empty board with nothing on is still drawn').toBeNull();
});
