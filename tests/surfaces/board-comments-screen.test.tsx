// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-8 and MP-5-12 from the Projects screen: a row's comment badge draws the
// counts `task.board` sent for the reader (their own open client signals and
// mentions on that task) and opens the task on its comments; a row the read
// sent none for draws no badge. The Review chip's count is the answer's
// `owed`, INB-1's one count, and the rows' own count only when a server that
// predates it sends none.

import { afterEach, describe, expect, it } from 'vitest';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const WAITING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const QUIET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const task = (id: string, key: string, over: Readonly<Record<string, unknown>>) => ({
  id,
  key,
  title: `Task ${key}`,
  state: { id: 's-1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 3,
  rank: { number: null, score: null, calc: 'not ranked: missing ease' },
  stage: null,
  clientSet: false,
  statePosition: 2000,
  awaitingDecision: false,
  ...over,
});

const TASKS = [
  task(WAITING, 'TSK-1', {
    comments: { client: 2, mentions: 1, latest: '2026-09-20T01:00:00.000Z' },
    awaitingDecision: true,
  }),
  task(QUIET, 'TSK-2', {}),
];

const server = (answer: Readonly<Record<string, unknown>>): typeof globalThis.fetch =>
  ((url: string) => {
    const at = String(url);
    if (at.endsWith('/live')) return Promise.resolve(new Response(null, { status: 503 }));
    if (at.endsWith('/inbox/read')) return Promise.resolve(json({ ok: true, inbox: [] }));
    if (at.endsWith('/inbox/count')) return Promise.resolve(json({ ok: true, owed: 0 }));
    if (at.includes('board')) {
      return Promise.resolve(
        json({ ok: true, tasks: TASKS, changedAt: null, viewer: null, ...answer }),
      );
    }
    return Promise.resolve(json({ ok: true, persons: [] }));
  }) as unknown as typeof globalThis.fetch;

const open = async (answer: Readonly<Record<string, unknown>>): Promise<Mounted> => {
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: server(answer),
    newOperationId: () => 'operation-1',
  });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 });
  const board = await mount(<Projects client={client} grantKey="alpha:ada" />);
  await settle();
  return board;
};

const badge = (board: Mounted, id: string): Element | null =>
  board.find(`tr[data-row="${id}"] td[data-key="comments"] a.cbd__cmt`);

const reviewCount = (board: Mounted): string | null | undefined =>
  board.find('[data-mode="review"] .cbd__count')?.textContent;

describe('MP-5-8 comment badge count and door, from the Projects screen', () => {
  it('draws the counts the read sent, opening the task on its comments; none sent draws none', async () => {
    mounted = await open({ owed: 4 });
    const drawn = badge(mounted, WAITING);
    expect(drawn?.getAttribute('href')).toMatch(/#comments$/u);
    expect(drawn?.textContent).toContain('3');
    expect(drawn?.getAttribute('title')).toMatch(
      /^2 from the client · 1 mentioning you · latest /u,
    );
    expect(badge(mounted, QUIET)).toBeNull();
  });
});

describe('MP-5-12 count across surfaces, from the Projects screen', () => {
  it('the Review chip counts INB-1’s owed count; the rows’ count only when none is sent', async () => {
    mounted = await open({ owed: 4 });
    expect(reviewCount(mounted)).toBe('4');
    await mounted.unmount();
    mounted = await open({});
    expect(reviewCount(mounted)).toBe('1');
  });
});
