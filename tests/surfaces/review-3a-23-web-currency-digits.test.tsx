// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-3A-23, the task page's share (round 2). The server counts minor units
// by the currency's own digits (core-runtime `four-eyes.ts` minorDigits: JPY
// 0), so 5000 minor units of JPY is five thousand yen and 5000 typed in JPY is
// 5000 minor units. Each screen on the task page that draws or sends money is
// held to that here: the proposals section and its money set aside, the
// propose form and the top-up, and the run's receipt. The real
// TaskDetailScreen and OperationsClient over a stand-in at HTTP.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, type Mounted } from './mount.tsx';

const TASK_ID = '33333333-3333-4333-8333-333333333333';
const RUN_ID = 'run-jpy';

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const tick = async (): Promise<void> => {
  await act(async () => {
    await pause();
    await pause();
    await pause();
  });
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

const version = {
  versionId: 'v-jpy',
  version: 1,
  purpose: 'book_the_venue',
  maximumMinor: 5_000,
  currency: 'JPY',
  payloadDigest: 'digest-jpy',
  payload: {},
  supersededAt: null,
  runId: RUN_ID,
  checks: [],
  evidence: null,
  gate: null,
};

const reservation = {
  id: 'r-jpy',
  envelopeId: 'env-jpy',
  runId: RUN_ID,
  state: 'held',
  heldMinor: 5_000,
  actualMinor: 3_000,
  releasedMinor: null,
  classifiedCause: null,
  leaseId: null,
  lease: null,
  attempt: null,
};

const task = {
  id: TASK_ID,
  key: 'TSK-23',
  title: 'A task budgeted in yen',
  description: null,
  state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 4,
  history: [],
  comments: [],
  proposals: [
    {
      lineageId: 'l-jpy',
      state: 'live',
      versions: [version],
      decisions: [],
      reservations: [reservation],
    },
  ],
  capCurrency: 'JPY',
  envelope: {
    id: 'env-jpy',
    capId: 'cap-jpy',
    currency: 'JPY',
    maximumMinor: 5_000,
    heldMinor: 5_000,
    actualMinor: 3_000,
  },
};

const execution = {
  ok: true,
  execution: {
    outcome: 'ready',
    taskId: TASK_ID,
    sourceRevision: 1,
    complete: true,
    next: null,
    runs: [
      {
        runId: RUN_ID,
        lineageId: 'l-jpy',
        versionId: 'v-jpy',
        state: 'handed_back',
        taskRevisionAtRequest: 4,
        createdAt: '2026-09-29T01:00:00.000Z',
      },
    ],
    events: [
      {
        eventId: 'e-1',
        runId: RUN_ID,
        position: 1,
        kind: 'handed_back',
        attemptId: 'a-jpy',
        at: '2026-09-29T01:00:00.000Z',
      },
    ],
    graph: {
      plan: 'unbound',
      sourceRevision: 1,
      complete: true,
      nodes: [
        {
          nodeId: RUN_ID,
          condition: 'settled',
          planned: null,
          observed: {
            condition: 'settled',
            runState: 'handed_back',
            attemptId: 'a-jpy',
            whoseMove: null,
            outcome: 'succeeded',
            fault: null,
            lease: null,
            effectObserved: true,
            heldMinor: 5_000,
            spentMinor: 3_000,
            currency: 'JPY',
          },
        },
      ],
    },
  },
};

const receipt = {
  ok: true,
  receipt: {
    attemptId: 'a-jpy',
    decision: { id: 'd-jpy' },
    version: { id: 'v-jpy', number: 1 },
    effect: { kind: 'comment', audience: 'internal' },
    settlement: { state: 'settled', heldMinor: 5_000, spentMinor: 3_000, releasedMinor: 2_000 },
  },
};

const live: Mounted[] = [];
afterEach(async () => {
  for (const page of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await page.unmount();
  }
});

async function open() {
  const sent: { readonly route: string; readonly body: Record<string, unknown> }[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const route = at.split('/').slice(-2).join('/');
    if (route === 'person/list') return Promise.resolve(json({ ok: true, persons: [] }));
    if (route === 'task/read') return Promise.resolve(json({ ok: true, task }));
    if (route === 'task/execution') return Promise.resolve(json(execution));
    if (route === 'task/receipt') return Promise.resolve(json(receipt));
    sent.push({ route, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return Promise.resolve(json({ recordId: TASK_ID, revision: 4, detail: {} }));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
    newOperationId: () => 'operation-23',
  });
  const page = await mount(
    <TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="TSK-23" />,
  );
  live.push(page);
  await tick();
  return { page, sent };
}

/** Five thousand yen, grouped or not, and never a fraction of a yen. */
const FIVE_THOUSAND = /5,?000(?![.\d])/u;

describe('REVIEW-3A-23 the task page counts each currency by its own digits', () => {
  it('REVIEW-3A-23 proposals: a JPY ceiling and its hold of 5000 minor units draw as five thousand yen', async () => {
    const { page } = await open();
    const said = page.find('[data-version-id="v-jpy"]')?.textContent ?? '';
    expect(said, 'ceiling drawn as if JPY had two minor digits').not.toContain('50.00');
    expect(said).toMatch(/JPY 5,?000(?![.\d])/u);
    const held = page.find('[data-reservation-id="r-jpy"]')?.textContent ?? '';
    expect(held, 'hold drawn as if JPY had two minor digits').not.toContain('50.00');
    expect(held).toMatch(FIVE_THOUSAND);
  });

  it('REVIEW-3A-23 propose form: 5000 typed in JPY sends maximumMinor 5000', async () => {
    const { page, sent } = await open();
    await page.type('#propose-purpose', 'book_the_venue');
    await page.type('#propose-maximum', '5000');
    await page.choose('#propose-currency', 'JPY');
    await page.click('[data-propose="submit"]');
    await tick();
    const propose = sent.find((call) => call.route === 'task/propose')?.body;
    expect(propose?.['currency']).toBe('JPY');
    expect(propose?.['maximumMinor'], 'yen typed are yen minor units').toBe(5_000);
  });

  it('REVIEW-3A-23 top-up: the JPY envelope draws whole yen, and 5000 typed sends amountMinor 5000', async () => {
    const { page, sent } = await open();
    const envelope = page.find('[data-top-up="envelope"]')?.textContent ?? '';
    expect(envelope, 'envelope drawn as if JPY had two minor digits').not.toContain('50.00');
    expect(envelope).toMatch(FIVE_THOUSAND);
    await page.type('#top-up-amount', '5000');
    await page.click('[data-top-up="submit"]');
    await tick();
    const topUp = sent.find((call) => call.route === 'budget/top_up')?.body;
    expect(topUp?.['amountMinor'], 'yen typed are yen minor units').toBe(5_000);
  });

  it('REVIEW-3A-23 run receipt: held, spent and released in JPY draw as whole yen', async () => {
    const { page } = await open();
    const money = page.find('[data-receipt-attempt="a-jpy"] [data-money]')?.textContent ?? '';
    expect(money).toBe('held 5000 · spent 3000 · released 2000');
  });
});
