// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// The Clients row door (DOCK.md section 2): the client the Clients panel is
// opened at (CS-7.29) carries a Projects door to the board filtered to that
// client, `/projects/?f=client:"<name>"`, the board's own Client facet. A press
// follows the dock's gesture law and the board in the panel opens on that
// client's work; the same address on the page draws the same view. The board
// names a row's client only where the read sends it (the reader's grants reach
// it, `client.list`'s rule), so a row whose client is withheld is never under
// the filter and nothing of that client is drawn.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { facetId } from '../../packages/ui/src/board/project-facets.ts';
import { settle, type Mounted } from '../surfaces/mount.tsx';
import { json, open } from './mp-2-1-support.tsx';

const ZENITH = { clientId: 'c-zenith', name: 'Zenith Physio' };
/** The board filtered to Zenith: the facet id the board itself gives the client. */
const ZENITH_BOARD = `/projects/?${new URLSearchParams({ f: facetId('client', ZENITH.name) }).toString()}`;
const SUMMIT = { clientId: 'c-summit', name: 'Summit Allied' };
/** A client the reader reaches with no task on the board they may see. */
const QUIET = { clientId: 'c-quiet', name: 'Quiet Clinic' };

const task = (n: number, client: { clientId: string; name: string } | null, clientSet = true) => ({
  id: `00000000-0000-4000-8000-00000000000${String(n)}`,
  key: `T-${String(n)}`,
  title: `Task ${String(n)}`,
  state: { id: 's-1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 1,
  rank: { number: null, score: null, calc: 'not ranked' },
  stage: null,
  clientSet,
  client,
  actualMinutes: 0,
  estimateMinutes: null,
  category: null,
  pageLink: null,
  statePosition: 1,
  waitReason: null,
  awaitingDecision: false,
});

const TASKS = [
  task(1, ZENITH),
  task(2, SUMMIT),
  task(3, ZENITH),
  task(4, null),
  task(5, null, false),
];

/** Alpha's server: the board, its clients and people; anything else is held open. */
const alpha: typeof globalThis.fetch = (url) => {
  const path = String(url);
  if (path.endsWith('/api/b/alpha/task/board'))
    return Promise.resolve(json({ ok: true, tasks: TASKS, changedAt: null, viewer: null }));
  if (path.endsWith('/api/b/alpha/client/list'))
    return Promise.resolve(json({ ok: true, clients: [QUIET, SUMMIT, ZENITH] }));
  if (path.endsWith('/api/b/alpha/person/list'))
    return Promise.resolve(json({ ok: true, persons: [] }));
  return new Promise<Response>(() => {});
};

const live: Mounted[] = [];
afterEach(async () => {
  for (const page of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await page.unmount();
  }
});

async function at(address: string): Promise<Mounted> {
  const { view } = await open(address, { fetch: alpha });
  live.push(view);
  for (let turn = 0; turn < 4; turn += 1) {
    // eslint-disable-next-line no-await-in-loop -- each answer lands before the next read
    await settle();
  }
  return view;
}

async function press(target: Element | null): Promise<void> {
  if (target === null) throw new Error('no target');
  await act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  for (let turn = 0; turn < 4; turn += 1) {
    // eslint-disable-next-line no-await-in-loop -- the panel's reads land
    await settle();
  }
}

const door = (page: Mounted): HTMLElement | null =>
  page.find('.content [aria-current="true"] .clbook__door') as HTMLElement | null;

describe('Clients row door', () => {
  it('the opened client row carries a Projects door to the board’s own Client filter', async () => {
    const page = await at('/clients/?client=c-zenith');
    const link = door(page);
    expect(link?.getAttribute('href')).toBe(ZENITH_BOARD);
    expect(link?.dataset['dockPlace']).toBe(ZENITH_BOARD);
    expect(link?.dataset['dockOpen']).toBe('todos');
    expect(link?.getAttribute('aria-label')).toBe("Open Projects, Zenith Physio's work");
    expect(link?.closest('.is-mock')).toBeNull();
  });

  it('a press opens Projects in the dock on that client’s work only', async () => {
    const page = await at('/clients/?client=c-zenith');
    await press(door(page));
    const panel = page.find('[data-panel-id="todos"]');
    expect(panel, 'no Projects panel opened').not.toBeNull();
    const rows = panel?.querySelectorAll('tbody tr[data-row]') ?? [];
    expect(rows.length).toBe(2);
    expect(panel?.textContent).toContain('Task 1');
    expect(panel?.textContent).toContain('Task 3');
    expect(panel?.textContent).not.toContain('Task 2');
  });

  it('the address on the page draws the same view, the Client column by name', async () => {
    const page = await at(ZENITH_BOARD);
    const board = page.find('.content');
    expect(board?.querySelectorAll('tbody tr[data-row]').length).toBe(2);
    expect(board?.textContent).not.toContain('Task 2');
    const whole = await at('/projects/');
    expect(whole.find('.content')?.textContent).toContain('Summit Allied');
  });
});

describe('Clients row door: review proofs', () => {
  it('a door to a client with no rows the reader sees opens no other client work', async () => {
    const page = await at('/clients/?client=c-quiet');
    await press(door(page));
    const panel = page.find('[data-panel-id="todos"]');
    expect(panel, 'no Projects panel opened').not.toBeNull();
    expect(panel?.querySelectorAll('tbody tr[data-row]').length).toBe(0);
    expect(panel?.textContent).toContain('No task matches that.');
    expect(panel?.textContent).not.toContain('Task 1');
  });

  it('a filter change in the Projects panel leaves the page address alone', async () => {
    window.history.replaceState(null, '', '/clients/?client=c-zenith');
    const page = await at('/clients/?client=c-zenith');
    await press(door(page));
    await press(page.find('[data-panel-id="todos"] .cbd__clear'));
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      '/clients/?client=c-zenith',
    );
  });
});

describe('Clients row door data separation', () => {
  it('a row whose client the read withholds is never under a client filter', async () => {
    const page = await at(ZENITH_BOARD);
    expect(page.find('.content')?.textContent).not.toContain('Task 4');
    const whole = await at('/projects/');
    expect(whole.find('.content')?.textContent).toContain('Task 4');
  });

  it('a client the reader does not reach gets no door, only the sentence', async () => {
    const page = await at('/clients/?client=c-bravo-only');
    expect(door(page)).toBeNull();
    expect(page.find('.clbook__opened')?.textContent).toBe(
      'The client you opened is not in your book.',
    );
  });
});
