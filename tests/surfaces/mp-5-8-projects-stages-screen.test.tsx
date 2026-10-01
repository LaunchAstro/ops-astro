// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The board's Stage column and stage editor read the task stage list (owner,
// Stage 1 adds; TASK_STAGES): a stored id draws its label, a stored value
// outside the list draws as stored, the editor offers the seven stages in
// order, and a choice sends `task.set_stage` with the stage's id at the row's
// revision.

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

const JOURNEY = '11111111-1111-4111-8111-111111111111';
const OUTSIDE = '22222222-2222-4222-8222-222222222222';

const task = (id: string, key: string, stage: string | null) => ({
  id,
  key,
  title: `Task ${key}`,
  state: { id: 's-1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 5,
  rank: { number: null, score: null, calc: 'not ranked: missing ease' },
  stage,
  clientSet: false,
  actualMinutes: 0,
  estimateMinutes: null,
  pageLink: null,
  statePosition: 1,
  waitReason: null,
  awaitingDecision: false,
});

const TASKS = [task(JOURNEY, 'TSK-1', 'enquiries'), task(OUTSIDE, 'TSK-2', 'Drafting')];

type Sent = { readonly url: string; readonly body: Readonly<Record<string, unknown>> }[];

const screen = async (sent: Sent): Promise<Mounted> => {
  const fetch = ((url: string, init?: { body?: string }) => {
    sent.push({
      url: String(url),
      body: JSON.parse(init?.body ?? '{}') as Record<string, unknown>,
    });
    if (String(url).includes('board')) {
      return Promise.resolve(
        json({ ok: true, tasks: TASKS, changedAt: null, viewer: null, withheld: 0 }),
      );
    }
    if (String(url).endsWith('person/list'))
      return Promise.resolve(json({ ok: true, persons: [] }));
    return Promise.resolve(json({ ok: true, recordId: JOURNEY, revision: 6, detail: {} }));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
    newOperationId: () => 'operation-1',
  });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 });
  mounted = await mount(<Projects navigate={() => {}} client={client} grantKey="alpha:ada" />);
  await settle();
  return mounted;
};

const CELL = (id: string): string => `tbody tr[data-row="${id}"] td[data-key="stage"]`;

describe('the task stage list on the Projects board', () => {
  it('draws a stored stage by its label, and one outside the list as stored', async () => {
    const board = await screen([]);
    const drawn = (id: string) => board.host.querySelector(`${CELL(id)} .cbd__chip`)?.textContent;
    expect([drawn(JOURNEY), drawn(OUTSIDE)]).toStrictEqual(['Enquiries', 'Drafting']);
  });

  it('offers the seven stages in order, and sends the chosen stage’s id', async () => {
    const sent: Sent = [];
    const board = await screen(sent);
    await board.click(`${CELL(JOURNEY)} button.cbd__edb`);
    const options = board.all(`${CELL(JOURNEY)} .sel__menu [role="option"]`);
    expect(options.map((each) => each.textContent).slice(0, 7)).toStrictEqual([
      'Awareness',
      'Trust',
      'Enquiries',
      'Sales',
      'Retention',
      'Advocacy',
      'Ops',
    ]);
    const sales = options.find((each) => each.textContent === 'Sales');
    // eslint-disable-next-line require-await -- act's async form flushes the event's effects
    await act(async () => {
      sales?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
    const commands = sent
      .filter((each) => each.url.endsWith('task/set_stage'))
      .map((each) => each.body);
    expect(commands).toStrictEqual([
      {
        recordId: JOURNEY,
        fields: { stage: 'sales' },
        operationId: 'operation-1',
        expectedRevision: 5,
      },
    ]);
  });
});
