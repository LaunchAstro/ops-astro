// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C54 on the Agent pane: its controls call `budget.record_outcome` (T3d1) and
// `budget.write_off` (T3c) through the page's real client, naming the task and
// the attempt the read showed, then read again. The HTTP boundary is stood in;
// what each command does under its locks is proven against Postgres by its
// own suites (`tests/runtime/t3d1-*`, `t3c-write-off*`).

/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name, as the pane's own tests do */

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, type Mounted } from './mount.tsx';

const TASK_ID = '66666666-6666-4666-8666-666666666666';
const ATTEMPT_ID = '77777777-7777-4777-8777-777777777777';

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

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface World {
  /** The newest attempt's state: `liability_unknown` is a stopped, unknown effect. */
  readonly attemptState: string;
  /** What a budget command answers: its detail, or a refusal with this code. */
  readonly answer: { readonly detail: Record<string, unknown> } | { readonly refuse: string };
}

function lineageOf(world: World) {
  return {
    lineageId: 'l-54',
    state: 'live',
    versions: [
      {
        versionId: 'v-54',
        version: 1,
        purpose: 'send_the_reply',
        maximumMinor: 1_800,
        currency: 'AUD',
        payloadDigest: 'digest-54',
        payload: {},
        supersededAt: null,
        runId: 'run-54',
        checks: [],
        evidence: null,
        gate: {
          id: 'g-54',
          state: 'approved',
          round: 0,
          expiresAt: '2026-10-01T00:00:00.000Z',
          expired: false,
          payloadDigest: 'digest-54',
        },
      },
    ],
    decisions: [],
    reservations: [
      {
        id: 'res-54',
        envelopeId: 'env-54',
        runId: 'run-54',
        state: 'held',
        heldMinor: 1_800,
        actualMinor: null,
        classifiedCause: null,
        lease: { state: 'expired' },
        attempt: { id: ATTEMPT_ID, state: world.attemptState },
      },
    ],
  };
}

function server(world: World) {
  const task = {
    id: TASK_ID,
    key: 'TSK-54',
    title: 'A task whose effect may have happened',
    description: null,
    state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
    assignee: null,
    due: null,
    priority: null,
    completedAt: null,
    revision: 3,
    history: [],
    comments: [],
    proposals: [lineageOf(world)],
  };
  const sent: { readonly route: string; readonly body: Record<string, unknown> }[] = [];
  let reads = 0;
  const answer = (url: string | URL, init?: RequestInit): Response => {
    const at = String(url);
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('/task/read')) {
      reads += 1;
      return json({ ok: true, task });
    }
    for (const route of ['budget/record_outcome', 'budget/write_off']) {
      if (at.endsWith(`/${route}`)) {
        sent.push({ route, body: JSON.parse(String(init?.body ?? '{}')) });
        return 'refuse' in world.answer
          ? json({ refused: true, code: world.answer.refuse, names: [], fixes: [] }, 403)
          : json({ ok: true, recordId: TASK_ID, detail: world.answer.detail });
      }
    }
    return json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
  };
  const fetch = ((url: string | URL, init?: RequestInit) =>
    Promise.resolve(answer(url, init))) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    token: 'a-token',
    fetch,
    newOperationId: () => 'operation-54',
  });
  return { client, sent, reads: () => reads };
}

const live: Mounted[] = [];
afterEach(async () => {
  for (const page of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await page.unmount();
  }
});

async function open(world: World) {
  const at = server(world);
  const page = await mount(
    <TaskDetailScreen client={at.client} grantKey="alpha:ada" taskKey="TSK-54" />,
  );
  live.push(page);
  await tick();
  return { ...at, page };
}

const UNKNOWN: World = { attemptState: 'liability_unknown', answer: { detail: {} } };
const IN_PANE = '[data-section="agent"]';

async function press(page: Mounted, selector: string): Promise<void> {
  const button = page.find(`${IN_PANE} ${selector}`) as HTMLButtonElement | null;
  expect(button, selector).not.toBeNull();
  expect(button?.disabled, `${selector} enabled`).toBe(false);
  await act(async () => {
    button?.click();
    await pause();
  });
  await tick();
}

async function type(page: Mounted, selector: string, value: string): Promise<void> {
  const field = page.find(`${IN_PANE} ${selector}`) as HTMLInputElement | null;
  expect(field, selector).not.toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(field) as object,
      'value',
    )?.set;
    setter?.call(field, value);
    field?.dispatchEvent(new Event('input', { bubbles: true }));
    await pause();
  });
}

describe('C54 the three outcomes on the Agent pane', () => {
  for (const [name, outcome] of [
    ['C54 nothing happened resumes', 'nothing_happened'],
    ['C54 happened finishes', 'happened'],
    ['C54 happened differently reopens', 'happened_differently'],
  ] as const) {
    it(`${name}: the pane records ${outcome} for the unknown attempt, then reads again`, async () => {
      const { page, sent, reads } = await open(UNKNOWN);
      const before = reads();
      await press(page, `[data-outcome="${outcome}"]`);
      expect(sent).toStrictEqual([
        {
          route: 'budget/record_outcome',
          body: { operationId: 'operation-54', recordId: TASK_ID, attemptId: ATTEMPT_ID, outcome },
        },
      ]);
      expect(reads()).toBeGreaterThan(before);
    });
  }

  it('C54 unknown keeps its stop: exactly three outcomes, never a fourth, and the stop stays said', async () => {
    const { page, sent } = await open(UNKNOWN);
    expect(
      page.all(`${IN_PANE} [data-outcome]`).map((button) => button.getAttribute('data-outcome')),
    ).toStrictEqual(['nothing_happened', 'happened', 'happened_differently']);
    expect(page.find(`${IN_PANE} [data-agent="unknown"]`)?.textContent).toContain(
      'stays stopped until a person says what happened',
    );
    expect(sent).toStrictEqual([]);
  });

  it('C54 unknown keeps its stop: an attempt whose effect is known draws no outcome and no write-off', async () => {
    const { page } = await open({ attemptState: 'settled', answer: { detail: {} } });
    expect(page.find(`${IN_PANE} [data-agent="pane"]`)).not.toBeNull();
    expect(page.all(`${IN_PANE} [data-outcome]`)).toHaveLength(0);
    expect(page.find(`${IN_PANE} [data-agent="write-off"]`)).toBeNull();
  });
});

// eslint-disable-next-line max-lines-per-function -- one page, each write-off case on it
describe('C54 the write-off on the Agent pane', () => {
  it('C54 write-off amount and reason: sends the amount to charge and the written reason, then reads again', async () => {
    const { page, sent, reads } = await open(UNKNOWN);
    const before = reads();
    await type(page, '[data-write-off="amount"]', '12.50');
    await type(page, '[data-write-off="reason"]', 'The reply went out once; the log shows it.');
    await press(page, '[data-write-off="submit"]');
    expect(sent).toStrictEqual([
      {
        route: 'budget/write_off',
        body: {
          operationId: 'operation-54',
          recordId: TASK_ID,
          attemptId: ATTEMPT_ID,
          amountMinor: 1_250,
          reason: 'The reply went out once; the log shows it.',
        },
      },
    ]);
    expect(reads()).toBeGreaterThan(before);
  });

  it('C54 write-off amount and reason: the amount starts at the reserved maximum, and nothing is a figure too', async () => {
    const { page, sent } = await open(UNKNOWN);
    const amount = page.find(`${IN_PANE} [data-write-off="amount"]`) as HTMLInputElement | null;
    expect(amount?.value).toBe('18.00');
    await type(page, '[data-write-off="amount"]', '0');
    await type(page, '[data-write-off="reason"]', 'Nothing was charged by the provider.');
    await press(page, '[data-write-off="submit"]');
    expect(sent.map((call) => call.body['amountMinor'])).toStrictEqual([0]);
  });

  it('C54 write-off amount and reason: no reason, or no amount, sends nothing', async () => {
    const { page, sent } = await open(UNKNOWN);
    const submit = (): HTMLButtonElement | null =>
      page.find(`${IN_PANE} [data-write-off="submit"]`) as HTMLButtonElement | null;
    expect(submit()?.disabled).toBe(true);
    await type(page, '[data-write-off="reason"]', 'A reason with no amount.');
    await type(page, '[data-write-off="amount"]', '');
    expect(submit()?.disabled).toBe(true);
    await type(page, '[data-write-off="reason"]', '   ');
    await type(page, '[data-write-off="amount"]', '3.00');
    expect(submit()?.disabled).toBe(true);
    await act(async () => {
      submit()?.click();
      await pause();
    });
    expect(sent).toStrictEqual([]);
  });

  it('C54 write-off amount and reason: above the band, the pane says a second approver is needed', async () => {
    const { page } = await open({
      attemptState: 'liability_unknown',
      answer: { detail: { state: 'awaiting_second_approver' } },
    });
    await type(page, '[data-write-off="reason"]', 'The provider billed the full amount.');
    await press(page, '[data-write-off="submit"]');
    expect(page.find(`${IN_PANE} [data-write-off="awaiting"]`)?.textContent).toContain(
      'a second person approves it too',
    );
  });
});

describe('C54 refusals on the Agent pane', () => {
  it('C54 refusal billing:decide: a person without it is told in words, and the stop stays', async () => {
    const { page, sent } = await open({
      attemptState: 'liability_unknown',
      answer: { refuse: 'SCOPE_NOT_GRANTED' },
    });
    await press(page, '[data-outcome="happened"]');
    expect(sent.map((call) => call.route)).toStrictEqual(['budget/record_outcome']);
    expect(page.find(`${IN_PANE} [role="alert"]`)?.textContent ?? '').not.toBe('');
    expect(page.all(`${IN_PANE} [data-outcome]`)).toHaveLength(3);
  });

  it.todo(
    'C54 consolidated stop answered (LEANS-ON SL11 AW-05: the third stop and its consolidated decision)',
  );
  it.todo('C54 an unknown broker effect’s three outcomes (LEANS-ON AW-10)');
});
