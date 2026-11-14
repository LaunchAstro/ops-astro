// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// #2347 (DECISIONS 91): the Tasks page opens on All tasks, and a reload opens
// on exactly the view its address names. Through the real Projects screen: a
// saved address reopens as it was (S2406-2), and the address the board itself
// writes after Clear all and after Review reopens showing the same tasks.

import { afterEach, describe, expect, it } from 'vitest';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle, type Mounted } from './mount.tsx';

const ME = '11111111-1111-4111-8111-111111111111';
const ALL = '.cbd__preset[data-preset="all"]';
const VIEWER = '.cbd__preset--viewer';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  window.history.replaceState(null, '', '/');
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const drawn = (board: Mounted): readonly string[] =>
  board.all('tbody tr[data-row]').map((each) => (each as HTMLElement).dataset['row'] ?? '');
const one = (board: Mounted, selector: string): Element | null =>
  board.host.querySelector(selector);
const titles = (view: Mounted): readonly (string | null)[] =>
  view.all('.rec__title').map((title) => title.textContent);

const boardTask = (id: string, key: string, assignee: string | null) => ({
  id,
  key,
  title: `Task ${key}`,
  state: { id: `s-${key}`, key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: assignee === null ? null : { personId: assignee, name: 'Nathan' },
  due: null,
  priority: null,
  completedAt: null,
  revision: 1,
  rank: { number: null, score: null, calc: 'not ranked: missing ease' },
  stage: null,
  clientSet: false,
  statePosition: 2000,
  awaitingDecision: assignee === null,
});
const MINE = boardTask('55555555-5555-4555-8555-555555555555', 'T-5', ME);
const NOBODYS = boardTask('66666666-6666-4666-8666-666666666666', 'T-6', null);

/** The real Projects screen, opened at a saved address, as a reload opens it. */
async function reopened(search: string, keep = false): Promise<Mounted> {
  window.history.replaceState(null, '', `/projects/${search}`);
  const fetch = (() =>
    Promise.resolve(
      json({ ok: true, tasks: [MINE, NOBODYS], changedAt: null, viewer: ME, withheld: 0 }),
    )) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 });
  mounted = await mount(<Projects navigate={() => {}} client={client} grantKey="alpha:nathan" />);
  await settle();
  if (!keep) window.history.replaceState(null, '', '/');
  return mounted;
}

// S2406-2: a saved address reopens as it was through the real Projects screen.
describe('#2347 a reload of a saved address opens on exactly its own view', () => {
  it('no address opens on All tasks; Mine’s address opens on Mine', async () => {
    expect(drawn(await reopened(''))).toStrictEqual([MINE.id, NOBODYS.id]);
    await mounted?.unmount();
    const mine = await reopened(`?f=assignee%3A${ME}`);
    expect(drawn(mine)).toStrictEqual([MINE.id]);
    expect(one(mine, VIEWER)?.classList.contains('is-on')).toBe(true);
  });

  it('a cleared view (empty f) reopens with every filter off, and Review reopens in Review', async () => {
    expect(drawn(await reopened(`?f=`))).toStrictEqual([MINE.id, NOBODYS.id]);
    await mounted?.unmount();
    const review = await reopened('?f=&mode=review');
    expect(one(review, '[data-mode="review"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(one(review, ALL)?.classList.contains('is-on')).toBe(false);
  });
});

// S2406-2 (round trip): the address the board itself writes after Clear all
// and after Review, reopened, shows the same tasks.
describe('#2347 Clear all and Review reopen from the address the board wrote', () => {
  it('a cleared view and a Review view each reopen showing the same tasks', async () => {
    const board = await reopened(`?f=assignee%3A${ME}`, true);
    expect(drawn(board)).toStrictEqual([MINE.id]);
    await board.click('button.cbd__clear');
    await settle();
    const cleared = window.location.search;
    expect(cleared).toMatch(/[?&]f=(&|$)/u);
    expect(drawn(board)).toStrictEqual([MINE.id, NOBODYS.id]);
    await board.unmount();
    const fromCleared = await reopened(cleared, true);
    expect(drawn(fromCleared)).toStrictEqual([MINE.id, NOBODYS.id]);

    await fromCleared.click('[data-mode="review"]');
    await settle();
    const review = window.location.search;
    expect(review).toContain('mode=review');
    expect(titles(fromCleared)).toStrictEqual(['Task T-6']);
    await fromCleared.unmount();
    expect(titles(await reopened(review, true))).toStrictEqual(['Task T-6']);
    window.history.replaceState(null, '', '/');
  });
});
