// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-8: the Actual column drawn from `task.board`'s `actualMinutes` through
// the Projects screen (the time logged on the task, MP-4-6). With no estimate
// on the task the burn bar has nothing to fill against, so the cell prints
// the time itself; a task with no time logged draws a dash. Against an
// estimate: mp-5-8-projects-estimate-screen.

import { afterEach, describe, expect, it } from 'vitest';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const task = (id: string, key: string, actualMinutes: number) => ({
  id,
  key,
  title: `Task ${key}`,
  state: { id: 's-active', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 1,
  rank: { number: null, score: null, calc: 'not ranked: missing ease' },
  stage: null,
  clientSet: false,
  actualMinutes,
  estimateMinutes: null,
  pageLink: null,
  statePosition: 1,
  waitReason: null,
  awaitingDecision: false,
});

const screen = async (tasks: readonly ReturnType<typeof task>[]): Promise<Mounted> => {
  const fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: true, tasks, changedAt: null, withheld: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    token: 'a-token',
    fetch,
    newOperationId: () => 'operation-1',
  });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 });
  mounted = await mount(<Projects client={client} grantKey="alpha:ada" />);
  await settle();
  return mounted;
};

const LOGGED = '11111111-1111-4111-8111-111111111111';
const NONE = '22222222-2222-4222-8222-222222222222';

describe('MP-5-8 column read-back: actual, drawn from task.board', () => {
  it('prints the time logged on the task, and a dash where none is', async () => {
    const board = await screen([task(LOGGED, 'TSK-1', 90), task(NONE, 'TSK-2', 0)]);
    const actual = (id: string) =>
      board.find(`tbody tr[data-row="${id}"] td[data-key="actual"]`)?.textContent;
    expect([actual(LOGGED), actual(NONE)]).toStrictEqual(['1.5h', '—']);
  });
});
