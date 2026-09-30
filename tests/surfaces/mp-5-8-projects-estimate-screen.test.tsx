// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-8, MP-5-9 and MP-5-10 on the task's stored estimate and page link
// (MP-4-8, MP-4-12), driven from the Projects screen: the Estimates cell and
// the burn bar draw `task.board`'s `estimateMinutes` against the time logged;
// the estimate edits in place through `task.update` at the row's revision,
// offering the task panel's choices; the hover door goes to the task's page
// link, in the app, and to the task's own page where there is none or where a
// stored value is not an address inside the product.

import { act } from 'react';
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

const SET = '11111111-1111-4111-8111-111111111111';
const BARE = '22222222-2222-4222-8222-222222222222';
const OVER = '33333333-3333-4333-8333-333333333333';
const HOSTILE = '44444444-4444-4444-8444-444444444444';

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
  actualMinutes: 0,
  estimateMinutes: null,
  pageLink: null,
  statePosition: 1,
  waitReason: null,
  awaitingDecision: false,
  ...over,
});

const TASKS = [
  task(SET, 'TSK-1', {
    estimateMinutes: 120,
    actualMinutes: 90,
    pageLink: '/clients/acme#brief',
    revision: 7,
  }),
  task(BARE, 'TSK-2', {}),
  task(OVER, 'TSK-3', { estimateMinutes: 60, actualMinutes: 90 }),
  task(HOSTILE, 'TSK-4', { pageLink: '//elsewhere.example/path' }),
];

type Sent = { readonly url: string; readonly body: Readonly<Record<string, unknown>> }[];

const server = (sent: Sent): typeof globalThis.fetch =>
  ((url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as Readonly<Record<string, unknown>>;
    sent.push({ url: String(url), body });
    if (String(url).includes('board')) {
      return Promise.resolve(
        json({ ok: true, tasks: TASKS, changedAt: null, viewer: null, withheld: 0 }),
      );
    }
    if (String(url).endsWith('person/list'))
      return Promise.resolve(json({ ok: true, persons: [] }));
    return Promise.resolve(json({ ok: true, recordId: SET, revision: 8, detail: {} }));
  }) as unknown as typeof globalThis.fetch;

const screen = async (sent: Sent): Promise<Mounted> => {
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    token: 'a-token',
    fetch: server(sent),
    newOperationId: () => 'operation-1',
  });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 });
  mounted = await mount(<Projects client={client} grantKey="alpha:ada" />);
  await settle();
  return mounted;
};

const CELL = (id: string, key: string): string =>
  `tbody tr[data-row="${id}"] td[data-key="${key}"]`;

const choose = async (board: Mounted, label: string): Promise<void> => {
  const option = board
    .all(`${CELL(SET, 'estimate')} .sel__menu [role="option"]`)
    .find((each) => each.textContent === label);
  expect(option, `no "${label}" in the estimate menu`).toBeDefined();
  // eslint-disable-next-line require-await -- act's async form flushes the event's effects
  await act(async () => {
    option?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};

describe('MP-5-8 cells as specified: estimate and burn, drawn from task.board', () => {
  it('prints the stored estimate, a dash where none is, and burns the time logged against it', async () => {
    const board = await screen([]);
    const text = (id: string, key: string) =>
      board.host.querySelector<HTMLElement>(CELL(id, key))?.textContent;
    expect([text(SET, 'estimate'), text(BARE, 'estimate'), text(OVER, 'estimate')]).toStrictEqual([
      '2h',
      '—',
      '1h',
    ]);
    const fill = (id: string) =>
      (
        board.host.querySelector<HTMLElement>(
          `${CELL(id, 'actual')} .brn__fill`,
        ) as HTMLElement | null
      )?.style.width;
    expect([fill(SET), fill(OVER)]).toStrictEqual(['75%', '100%']);
    expect(
      board.host.querySelector<HTMLElement>(`${CELL(OVER, 'actual')} .brn`)?.className,
    ).toContain('is-over');
    expect(
      board.host.querySelector<HTMLElement>(`${CELL(SET, 'actual')} .brn`)?.getAttribute('title'),
    ).toBe('1.5h of 2h');
  });
});

describe('MP-5-10 the estimate edits in place', () => {
  it('offers the panel’s choices and sends task.update at the row’s revision, clearing to not set', async () => {
    const sent: Sent = [];
    const board = await screen(sent);
    await board.click(`${CELL(SET, 'estimate')} button.cbd__edb`);
    const labels = board
      .all(`${CELL(SET, 'estimate')} .sel__menu [role="option"]`)
      .map((each) => each.textContent);
    expect(labels).toStrictEqual(['15m', '30m', '1h', '2h', '4h', '1d', '2d', 'Not set']);
    await choose(board, '4h');
    await settle();
    await board.click(`${CELL(SET, 'estimate')} button.cbd__edb`);
    await choose(board, 'Not set');
    await settle();
    const commands = sent
      .filter((each) => !each.url.includes('board') && !each.url.endsWith('person/list'))
      .map((each) => [each.url.split('/').slice(-2).join('/'), each.body]);
    const at = { operationId: 'operation-1', expectedRevision: 7 };
    expect(commands).toStrictEqual([
      ['task/update', { recordId: SET, fields: { estimated_minutes: 240 }, ...at }],
      ['task/update', { recordId: SET, fields: { estimated_minutes: null }, ...at }],
    ]);
  });
});

describe('MP-5-9 the hover box holds a door with its in-app mark', () => {
  it('goes to the task’s page link in the app, and to the task’s own page without a safe one', async () => {
    const board = await screen([]);
    const door = (id: string) =>
      board.host.querySelector<HTMLElement>(`${CELL(id, 'name')} a[data-route="door"]`);
    expect([door(SET)?.getAttribute('href'), door(SET)?.dataset['mark']]).toStrictEqual([
      '/clients/acme#brief',
      'in-app',
    ]);
    const own = (id: string) =>
      board.host.querySelector<HTMLElement>(`${CELL(id, 'name')} a.cbd__nm`)?.getAttribute('href');
    expect(door(BARE)?.getAttribute('href')).toBe(own(BARE));
    expect(door(HOSTILE)?.getAttribute('href')).toBe(own(HOSTILE));
    expect(board.host.querySelector<HTMLElement>(CELL(HOSTILE, 'name'))?.innerHTML).not.toContain(
      'elsewhere.example',
    );
  });
});
