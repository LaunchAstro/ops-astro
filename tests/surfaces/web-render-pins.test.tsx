// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Rendered-output pins for the web refactors (thermo review H8, H9, M12-M15).
//
// Those rows move code without meaning to change a single byte of what a
// person sees. The existing surface tests assert the parts that carry meaning;
// these pin the whole of the markup, so a moved component, a shared write
// state or a looked-up route that changes an attribute, a class or a disabled
// control shows here as a diff rather than passing unnoticed.
//
// The task page is pinned with its gate pending, decided and expired, and after
// the three writes whose settlement the refactor shares: a refused comment, a
// stale save and a refused decision. The board is pinned with a task in every
// machine category and one with no state, because the tone map moves too.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskTimerProvider } from '../../apps/web/src/screens/task/task-timer-context.tsx';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';
import { tick, json, refused, taskServer, taskPage } from './task-page-fixture.tsx';

// The history says how long ago each change was (MP-4-16), so the reader's
// clock is fixed here: a pin that moved every day would pin nothing. Only
// Date is faked; the timers the page waits on stay real.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-29T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the task page, pinned whole', () => {
  theTaskPageCases1();
  theTaskPageCases2();
});

function theTaskPageCases1() {
  for (const [name, gate] of [
    ['pending', { state: 'pending', expired: false }],
    ['decided', { state: 'approved', expired: false }],
    ['expired', { state: 'expired', expired: true }],
  ] as const) {
    it(`draws a ${name} gate`, async () => {
      const page = await taskPage(taskServer(gate));
      expect(page.host.innerHTML).toMatchSnapshot();
      await page.unmount();
    });
  }

  it('after a comment refused for want of the grant', async () => {
    const client = taskServer(
      { state: 'pending', expired: false },
      { '/task/comment': refused('SCOPE_NOT_GRANTED', 403) },
    );
    const page = await taskPage(client);
    await page.type('#comment-body', 'Hello');
    await page.click('[data-comment="post"]');
    await tick();
    expect(page.host.innerHTML).toMatchSnapshot();
    await page.unmount();
  });

  it('after a save refused as stale, with the draft held', async () => {
    const client = taskServer(
      { state: 'pending', expired: false },
      { '/task/update': refused('VERSION_STALE', 409) },
    );
    const page = await taskPage(client);
    await page.type('#task-title', 'A newer title');
    expect(page.host.innerHTML).toMatchSnapshot('dirty');
    await page.click('[data-draft-resolve="save"]');
    await tick();
    expect(page.host.innerHTML).toMatchSnapshot('conflict');
    await page.unmount();
  });
}

function theTaskPageCases2() {
  it('after a lifecycle write refused', async () => {
    const client = taskServer(
      { state: 'pending', expired: false },
      { '/task/start': refused('TRANSITION_PROTECTED', 409) },
    );
    const page = await taskPage(client);
    await page.click('[data-lifecycle="start"]');
    await tick();
    expect(page.host.innerHTML).toMatchSnapshot();
    await page.unmount();
  });

  it('after a decision refused', async () => {
    const client = taskServer(
      { state: 'pending', expired: false },
      { '/task/decide': refused('SCOPE_NOT_GRANTED', 403) },
    );
    const page = await taskPage(client);
    await page.click('[data-decide="approve"]');
    await tick();
    expect(page.host.innerHTML).toMatchSnapshot();
    await page.unmount();
  });
}

/** A task in every machine category and one with no state, as task.board answers them. */
const CATEGORIES = ['unstarted', 'started', 'backlog', 'completed', 'cancelled', 'invented'];
const BOARD_TASKS = [
  ...CATEGORIES.map((category, index) => ({
    id: `t-${String(index)}`,
    key: `TSK-${String(index)}`,
    title: `A ${category} task`,
    state: {
      id: `s-${category}`,
      key: category,
      label: `L-${category}`,
      machineCategory: category,
    },
    assignee: null,
    due: null,
    // The wire always carries it; left out, the row would read as completed.
    completedAt: null,
    revision: 1,
    rank: { number: null, score: null, calc: '' },
    stage: null,
    clientSet: false,
  })),
  {
    id: 't-none',
    key: 'TSK-none',
    title: 'A task with no state',
    state: null,
    assignee: { personId: 'p-1', name: 'Ada' },
    due: '2020-01-01T00:00:00.000Z',
    completedAt: null,
    revision: 1,
    rank: { number: null, score: null, calc: '' },
    stage: null,
    clientSet: false,
  },
];

describe('the board, pinned whole', () => {
  it('draws a task in every machine category and one with no state', async () => {
    const fetch = (async (url: string | URL) => {
      const at = String(url);
      if (at.endsWith('/task/board')) return json({ ok: true, tasks: BOARD_TASKS });
      // The inbox the board screen mounts above the board (INB-1g), empty.
      if (at.endsWith('/inbox/read')) return json({ ok: true, inbox: [] });
      if (at.endsWith('/inbox/count')) return json({ ok: true, owed: 0 });
      return refused('NOT_FOUND', 404);
    }) as unknown as typeof globalThis.fetch;
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch,
      newOperationId: () => 'operation-1',
    });
    const page = await mount(
      <TaskTimerProvider client={client} grantKey="alpha:ada" storage={null}>
        <Projects client={client} grantKey="alpha:ada" navigate={() => {}} />
      </TaskTimerProvider>,
    );
    await tick();
    expect(page.host.innerHTML).toMatchSnapshot();
    await page.unmount();
  });
});
