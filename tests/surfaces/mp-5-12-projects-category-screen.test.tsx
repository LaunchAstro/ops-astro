// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The board's category chips (P-13, M-04) read the stored category from the
// row (`task.set_category`, CS-4.16): a catalogue id draws its label
// (TASK_CATEGORIES), a stored value outside the list draws as stored, and a
// task with none offers no chip.

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

const task = (id: string, key: string, category: string | null) => ({
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
  stage: null,
  category,
  clientSet: false,
  actualMinutes: 0,
  estimateMinutes: null,
  pageLink: null,
  statePosition: 1,
  waitReason: null,
  awaitingDecision: false,
});

const TASKS = [
  task('11111111-1111-4111-8111-111111111111', 'TSK-1', 'paid-ads'),
  task('22222222-2222-4222-8222-222222222222', 'TSK-2', 'Legacy work'),
  task('33333333-3333-4333-8333-333333333333', 'TSK-3', null),
];

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
    return Promise.resolve(json({ ok: true, recordId: 'r', revision: 6, detail: {} }));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
    newOperationId: () => 'operation-1',
  });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 });
  mounted = await mount(<Projects client={client} grantKey="alpha:ada" />);
  await settle();
  return mounted;
};

describe('the task category list on the Projects board', () => {
  it('draws a chip per stored category, by its label, and one outside the list as stored', async () => {
    const board = await screen([]);
    const chips = [...board.host.querySelectorAll('[data-preset^="cat-"]')].map((chip) =>
      chip.textContent?.trim(),
    );
    expect(chips.toSorted()).toStrictEqual(['Legacy work', 'Paid Ads']);
  });
});
