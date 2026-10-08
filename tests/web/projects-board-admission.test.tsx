// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { encodeBoardAddress } from '../../apps/web/src/screens/projects/scoped-board.ts';
import { mount } from '../surfaces/mount.tsx';
import { tick } from './work-log-stand-in.tsx';
import {
  boardA,
  scopedPerson,
  scopedClient,
  panel,
  destinationServer,
} from './projects-board-destination-support.tsx';
const place = (kind: 'aggregate' | 'selected' | 'unboarded') =>
  encodeBoardAddress({
    ...(kind === 'selected' ? { kind, boardId: boardA } : { kind }),
    person: scopedPerson,
    client: scopedClient,
    filters: [],
    focus: null,
  });
const make = (upper: boolean) =>
  encodeBoardAddress({
    kind: 'selected',
    boardId: upper ? boardA.toUpperCase() : boardA,
    person: upper ? scopedPerson.toUpperCase() : scopedPerson,
    client: upper ? scopedClient.toUpperCase() : scopedClient,
    filters: [],
    focus: null,
  });
it('aggregate selected and unboarded destinations send distinct checked reads and preserve reader ranks', async () => {
  const api = destinationServer();

  const view = await mount(panel(api.client, place('aggregate')));
  await tick();
  await tick();
  expect(api.asked.at(-1)).toEqual({
    mode: 'aggregate',
    person: scopedPerson,
    client: scopedClient,
  });
  expect(view.all('[data-row]')).toHaveLength(3);
  expect(view.text()).toContain('Current teammate');
  expect(view.text()).toContain('6 messages waiting on us');
  expect(
    view.all('.cbd__rank').map((rank) => [rank.textContent, rank.getAttribute('title')]),
  ).toEqual([
    ['7', 'reader pool'],
    ['8', 'reader pool'],
    ['9', 'reader pool'],
  ]);
  await view.render(panel(api.client, place('selected')));
  await tick();
  await tick();
  expect(api.asked.at(-1)).toEqual({ board: boardA, person: scopedPerson, client: scopedClient });
  expect(view.all('[data-row]')).toHaveLength(1);
  expect(view.text()).toContain('Scoped work 1');
  await view.render(panel(api.client, place('unboarded')));
  await tick();
  await tick();
  expect(api.asked.at(-1)).toEqual({ board: null, person: scopedPerson, client: scopedClient });
  expect(view.all('[data-row]')).toHaveLength(1);
  expect(view.text()).toContain('Scoped work 3');
});
it('aggregate scope intersects compact filters runtime route focused comment and waiting count', async () => {
  const api = destinationServer();
  api.tasks[1]!.todo.whoseMove = 'Team';
  const address = encodeBoardAddress({
    kind: 'aggregate',
    person: scopedPerson,
    client: scopedClient,
    route: 'Review',
    filters: [
      { kind: 'due', value: 'today' },
      { kind: 'priority', value: 1 },
      { kind: 'tag', value: 'urgent' },
      { kind: 'words', value: 'work' },
      { kind: 'waiting' },
    ],
    focus: 'Scope-3',
  });
  const view = await mount(panel(api.client, address));
  await tick();
  await tick();
  expect(view.all('[data-row]')).toHaveLength(1);
  expect(view.text()).toContain('Scoped work 3');
  expect(view.text()).not.toContain('Scoped work 2');
  expect(view.find('[data-board-waiting-count]')?.textContent).toContain('3 messages');
  expect(view.find('[data-board-reading]')?.textContent).toContain('due today');
  expect(view.find('[data-board-reading]')?.textContent).toContain('Current client');
});
it('permission pending and revoked destinations hide prior rows names counts and ignore held answers', async () => {
  const api = destinationServer();
  const address = encodeBoardAddress({
    kind: 'aggregate',
    person: scopedPerson,
    client: scopedClient,
    filters: [],
    focus: null,
  });
  const view = await mount(panel(api.client, address));
  await tick();
  await tick();
  expect(view.all('[data-row]')).toHaveLength(3);
  api.holdNext();
  await act(async () => {
    api.invalidate();
    await Promise.resolve();
  });
  await tick();
  expect(view.all('[data-row]')).toHaveLength(0);
  expect(view.find('[data-board-reading]')).toBeNull();
  expect(view.find('[data-board-waiting-count]')).toBeNull();
  api.revoke();
  await act(async () => {
    api.invalidate();
    await Promise.resolve();
  });
  await tick();
  await act(async () => {
    api.release();
    await Promise.resolve();
  });
  await tick();
  expect(view.all('[data-row]')).toHaveLength(0);
  expect(view.text()).not.toContain('Current teammate');
  expect(view.text()).not.toContain('Current client');
});
it('malformed duplicate and contradictory destinations never fall back to a wider board', async () => {
  const api = destinationServer();
  const view = await mount(panel(api.client, '/projects/?pool=aggregate&board=none&scope=own'));
  await tick();
  expect(api.asked).toEqual([]);
  for (const query of [
    'board=bad',
    'pool=all&scope=own',
    'pool=aggregate',
    `board=${boardA}&board=none`,
    `pool=aggregate&person=${scopedPerson}&scope=own`,
    'pool=aggregate&scope=own&filters=%5B%7B%22kind%22%3A%22person%22%7D%5D',
  ]) {
    // eslint-disable-next-line no-await-in-loop -- one owner opens invalid places in order.
    await view.render(panel(api.client, `/projects/?${query}`));
    expect(view.text()).toContain('The board scope is invalid.');
    expect(view.all('[data-row]')).toHaveLength(0);
  }
  expect(api.asked).toEqual([]);
});

it('a healthy unchanged board stream still refreshes authority vocabulary on its existing floor', async () => {
  vi.useFakeTimers();
  try {
    const api = destinationServer();
    const address = encodeBoardAddress({
      kind: 'aggregate',
      person: scopedPerson,
      client: scopedClient,
      filters: [],
      focus: null,
    });
    const view = await mount(panel(api.client, address));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(view.text()).toContain('Current teammate');
    api.revoke();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(view.text()).not.toContain('Current teammate');
    expect(view.text()).not.toContain('Current client');
    expect(view.all('[data-row]')).toHaveLength(0);
    await view.unmount();
  } finally {
    vi.useRealTimers();
  }
});

it.each(['vocabulary', 'person', 'client', 'rows'])(
  'a transient %s outage withdraws projection but restores the same unsent editor on recovery',
  async (dependency) => {
    const api = destinationServer();
    const address = encodeBoardAddress({
      kind: 'aggregate',
      person: scopedPerson,
      client: scopedClient,
      filters: [],
      focus: null,
    });
    const view = await mount(panel(api.client, address));
    await tick();
    await tick();
    await act(() => {
      view.find('a.cbd__nm')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await view.type('.cbd__rename', 'Kept through outage');
    const editor = view.find('.cbd__rename');
    api.outage(true, dependency);
    await act(async () => {
      api.invalidate();
      await Promise.resolve();
    });
    await tick();
    expect(view.all('[data-row]')).toHaveLength(0);
    expect(view.text()).not.toContain('Current teammate');
    expect(view.text()).not.toContain('Current client');
    expect(view.find('[data-outcome="unavailable"]')).not.toBeNull();
    api.outage(false, dependency);
    await act(async () => {
      api.invalidate();
      await Promise.resolve();
    });
    await tick();
    expect(view.find('.cbd__rename')).toBe(editor);
    expect(view.host.querySelector<HTMLInputElement>('.cbd__rename')?.value).toBe(
      'Kept through outage',
    );
    expect(api.mutations).toEqual([]);
  },
);

it('equivalent uppercase destination identities use canonical reads rows and labels', async () => {
  const api = destinationServer();

  const view = await mount(panel(api.client, make(false)));
  await tick();
  await tick();
  const before = {
    read: api.asked.at(-1),
    rows: view
      .all('[data-row]')
      .map((row) => (row instanceof HTMLElement ? row.dataset['row'] : null)),
    label: view.find('[data-board-reading]')?.textContent,
  };
  await view.render(panel(api.client, make(true)));
  await tick();
  await tick();
  expect({
    read: api.asked.at(-1),
    rows: view
      .all('[data-row]')
      .map((row) => (row instanceof HTMLElement ? row.dataset['row'] : null)),
    label: view.find('[data-board-reading]')?.textContent,
  }).toEqual(before);
});
it('a healthy unchanged stream refreshes tag filtered board membership and waiting count on the existing floor', async () => {
  vi.useFakeTimers();
  try {
    const api = destinationServer();
    const address = encodeBoardAddress({
      kind: 'aggregate',
      client: scopedClient,
      filters: [{ kind: 'tag', value: 'urgent' }],
      focus: null,
    });
    const view = await mount(panel(api.client, address));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(view.all('[data-row]')).toHaveLength(3);
    expect(view.find('[data-board-waiting-count]')?.textContent).toContain('6 messages');
    api.tasks[2]!.todo.tags = [];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(view.all('[data-row]')).toHaveLength(2);
    expect(view.find('[data-board-waiting-count]')?.textContent).toContain('3 messages');
    await view.unmount();
  } finally {
    vi.useRealTimers();
  }
});
