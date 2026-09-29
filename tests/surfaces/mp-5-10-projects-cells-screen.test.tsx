// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-10: the board's cell editors, driven from the Projects screen. The
// assignee is `task.assign`, the due date `task.update` on `due` and the stage
// `task.set_stage`, each at the revision the board read for that task; the
// people the assignee menu offers come from `person.list`.

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

const TASK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ADA = { personId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Ada Park' };
const BEN = { personId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Ben Ito' };

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
  task(TASK_ID, 'TSK-1', { assignee: ADA, due: '2026-10-05', stage: 'Drafting', revision: 7 }),
  task(OTHER_ID, 'TSK-2', { stage: 'Review' }),
];

type Sent = { readonly url: string; readonly body: Readonly<Record<string, unknown>> }[];

/** Answers the board and the people, and every command with success, keeping what it was sent. */
const server = (sent: Sent): typeof globalThis.fetch =>
  ((url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as Readonly<Record<string, unknown>>;
    sent.push({ url: String(url), body });
    if (String(url).includes('board')) {
      return Promise.resolve(
        json({ ok: true, tasks: TASKS, changedAt: null, viewer: null, withheld: 0 }),
      );
    }
    if (String(url).endsWith('person/list')) {
      return Promise.resolve(json({ ok: true, persons: [ADA, BEN] }));
    }
    return Promise.resolve(json({ ok: true, recordId: TASK_ID, revision: 8, detail: {} }));
  }) as unknown as typeof globalThis.fetch;

const CELL = (key: string): string => `tr[data-row="${TASK_ID}"] td[data-key="${key}"]`;

const choose = async (board: Mounted, key: string, label: string): Promise<void> => {
  const option = board
    .all(`${CELL(key)} .sel__menu [role="option"]`)
    .find((each) => each.textContent === label);
  // eslint-disable-next-line require-await -- act's async form flushes the event's effects
  await act(async () => {
    option?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};

describe('MP-5-10 the cells’ commands from the Projects screen', () => {
  it('assignee, due and stage each send their command at the row’s revision', async () => {
    const sent: Sent = [];
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
    await mounted.click(`${CELL('assignee')} button.cbd__edb`);
    await choose(mounted, 'assignee', 'Ben Ito');
    await settle();
    await mounted.click(`${CELL('due')} button.cbd__edb`);
    await mounted.type(`${CELL('due')} .cbd__ed input[type="date"]`, '2026-10-09');
    await settle();
    await mounted.click(`${CELL('stage')} button.cbd__edb`);
    await choose(mounted, 'stage', 'Review');
    await settle();
    const commands = sent
      .filter((each) => !each.url.includes('board') && !each.url.endsWith('person/list'))
      .map((each) => [each.url.split('/').slice(-2).join('/'), each.body]);
    const at = { operationId: 'operation-1', expectedRevision: 7 };
    expect(commands).toStrictEqual([
      ['task/assign', { recordId: TASK_ID, fields: { assignee: BEN.personId }, ...at }],
      ['task/update', { recordId: TASK_ID, fields: { due: '2026-10-09' }, ...at }],
      ['task/set_stage', { recordId: TASK_ID, fields: { stage: 'Review' }, ...at }],
    ]);
    expect(sent.filter((each) => each.url.endsWith('person/list'))).toHaveLength(1);
  });
});
