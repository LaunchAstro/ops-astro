// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The board kept drawn through an empty reread (#902) is one reader's and one
// filter's own. A switch to another person in the same business whose first
// read answers no tasks says the page's empty words and draws nothing of the
// person before, not their name either; and a client filter held through an
// empty answer keeps another client's task hidden until the person drops it.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from './mount.tsx';

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const ADA = { personId: 'p-ada', name: 'Ada Quill' };

const task = (id: string, over: { assignee?: typeof ADA; client?: { name: string } } = {}) => ({
  id,
  key: id,
  title: `Task ${id}`,
  state: { id: 's-1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: over.assignee ?? null,
  ...(over.client === undefined ? {} : { client: over.client }),
  due: null,
  priority: null,
  completedAt: null,
  revision: 1,
  rank: { number: null, score: null, calc: 'not ranked: missing ease' },
  stage: null,
  clientSet: over.client !== undefined,
  statePosition: 1000,
  awaitingDecision: false,
  estimateMinutes: null,
  actualMinutes: 0,
  pageLink: null,
});

/** One reader's API: board reads answer in turn; the live stream is the test's to write. */
function reader(answers: readonly (readonly ReturnType<typeof task>[])[], clients: string[] = []) {
  let reads = 0;
  const encoder = new TextEncoder();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const fetch = ((url: string) => {
    const at = String(url);
    if (/\/live(\?|$)/u.test(at)) {
      const body = new ReadableStream<Uint8Array>({ start: (c) => void streams.push(c) });
      return Promise.resolve(new Response(body, { status: 200 }));
    }
    if (at.endsWith('/inbox/read')) return Promise.resolve(json({ ok: true, inbox: [] }));
    if (at.endsWith('/inbox/count')) return Promise.resolve(json({ ok: true, owed: 0 }));
    if (at.endsWith('/task/board')) {
      const tasks = answers[Math.min(reads, answers.length - 1)] ?? [];
      reads += 1;
      return Promise.resolve(json({ ok: true, tasks, changedAt: null, viewer: null, withheld: 0 }));
    }
    if (at.endsWith('person/list')) return Promise.resolve(json({ ok: true, persons: [ADA] }));
    return Promise.resolve(json({ ok: true, clients: clients.map((name) => ({ name })) }));
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

async function reread(api: ReturnType<typeof reader>): Promise<void> {
  const before = api.reads();
  api.invalidate();
  for (let i = 0; i < 50 && api.reads() === before; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- wait for the live reread to be asked
    await act(pause);
  }
  expect(api.reads(), 'the live invalidation reread the board').toBe(before + 1);
  await settleAll();
}

const EMPTY = 'No tasks on this board yet.';

const at = (api: ReturnType<typeof reader>, grantKey: string) => (
  <Projects client={api.client} grantKey={grantKey} navigate={() => {}} />
);

it('a switch to another person whose first read is empty draws nothing of the person before', async () => {
  // A free word survives a board with no rows, so a board kept drawn would draw its search.
  window.history.replaceState(null, '', '/projects/?f=assignee%3Ap-ada&q=task');
  const ada = reader([[task('ada-1', { assignee: ADA })], []]);
  const ben = reader([[]]);
  const view = await mount(at(ada, 'alpha:ada'));
  await settleAll();
  expect(view.find('tr[data-row="ada-1"]')).not.toBeNull();
  expect(view.text()).toContain('Ada Quill');

  await view.render(at(ben, 'alpha:ben'));
  await settleAll();
  expect(view.find('[data-board]'), 'a board kept from the person before').toBeNull();
  expect(view.text(), 'the person before is named on the new reader’s page').not.toContain('Ada');
  expect(view.text()).toContain(EMPTY);

  await view.render(at(ada, 'alpha:ada'));
  await settleAll();
  expect(view.find('[data-board]'), 'a return was read as a kept reread').toBeNull();
  expect(view.text()).toContain(EMPTY);
});

it('a client filter held through an empty answer keeps the other client’s task hidden until dropped', async () => {
  window.history.replaceState(null, '', '/projects/?f=client%3A%22A%20Co%22');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 });
  const api = reader(
    [[task('a-1', { client: { name: 'A Co' } })], [], [task('b-1', { client: { name: 'B Co' } })]],
    ['A Co', 'B Co'],
  );
  const view = await mount(
    <Projects client={api.client} grantKey="alpha:mia" navigate={() => {}} />,
  );
  await settleAll();
  const rows = () => view.all('tr[data-row]').map((one) => (one as HTMLElement).dataset['row']);
  const aTag = () =>
    view.all('.cbd__tag').find((tag) => (tag.textContent ?? '').includes('A Co')) ?? null;
  expect(rows()).toEqual(['a-1']);
  expect(aTag()).not.toBeNull();

  await reread(api);
  expect(aTag(), 'the empty answer dropped A Co’s filter from view').not.toBeNull();
  await reread(api);
  expect(rows(), 'B Co’s task shows while A Co’s filter is still on').toEqual([]);
  expect(aTag()?.querySelector('.cbd__tagx'), 'A Co’s filter cannot be removed').not.toBeNull();

  // eslint-disable-next-line require-await -- act's async form flushes the event's effects
  await act(async () => {
    (aTag()?.querySelector('.cbd__tagx') as HTMLElement | null)?.click();
  });
  await settleAll();
  expect(rows(), 'dropping A Co’s filter shows B Co’s task').toEqual(['b-1']);
});
