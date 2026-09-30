// SPDX-License-Identifier: AGPL-3.0-only
//
// C54's page harness: the real TaskDetailScreen and OperationsClient over a
// stand-in at HTTP, a task whose read carries the proposals and the ledger a
// test names, and every command the Agent pane sends recorded by route. What
// each command does under its locks is proven against Postgres by its own
// suites. A harness, not a suite: nothing here runs on its own.

/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name, as the pane's own tests do */

import { act } from 'react';
import { afterEach, expect } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, type Mounted } from './mount.tsx';

export const TASK_ID = '66666666-6666-4666-8666-666666666666';
export const ATTEMPT_ID = '77777777-7777-4777-8777-777777777777';

export const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

export const tick = async (): Promise<void> => {
  await act(async () => {
    await pause();
    await pause();
    await pause();
  });
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export interface World {
  /** The newest attempt's state: `liability_unknown` is a stopped, unknown effect. */
  readonly attemptState: string;
  /** What a budget command answers: its detail, or a refusal with this code. */
  readonly answer: { readonly detail: Record<string, unknown> } | { readonly refuse: string };
  /** AW-05's stops on the task's runs, as the read's ledger carries them. */
  readonly stops?: readonly Record<string, unknown>[];
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

/** The commands the Agent pane sends: C54's acts on an unknown effect and its answers at a budget stop. */
const SENT_ROUTES = [
  'budget/record_outcome',
  'budget/write_off',
  'run/top_up',
  'run/end_at_budget_stop',
];

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
    ...(world.stops === undefined ? {} : { ledger: { envelopes: [], stops: world.stops } }),
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
    for (const route of SENT_ROUTES) {
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

export async function open(world: World) {
  const at = server(world);
  const page = await mount(
    <TaskDetailScreen client={at.client} grantKey="alpha:ada" taskKey="TSK-54" />,
  );
  live.push(page);
  await tick();
  return { ...at, page };
}

export const IN_PANE = '[data-section="agent"]';

export async function press(page: Mounted, selector: string): Promise<void> {
  const button = page.find(`${IN_PANE} ${selector}`) as HTMLButtonElement | null;
  expect(button, selector).not.toBeNull();
  expect(button?.disabled, `${selector} enabled`).toBe(false);
  await act(async () => {
    button?.click();
    await pause();
  });
  await tick();
}

export async function type(page: Mounted, selector: string, value: string): Promise<void> {
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
