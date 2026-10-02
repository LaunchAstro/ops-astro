// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-21 (red proof): a refused board write must be shown. The
// board's commands go through projects-row.ts `send`, which does
// `void sent.then(reload, reload)`: `client.mutate` resolves with a refusal
// and never rejects (operations/client.ts), so the CallResult is dropped and a
// VERSION_STALE refusal changes nothing the person can see but a re-read.
// Fixed when `send` reads the result and draws a refusal's words (status or
// alert, the code verbatim) as well as re-reading the board.

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

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const TASK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADA = { personId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Ada Park' };
const BEN = { personId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Ben Ito' };

const TASK = {
  id: TASK_ID,
  key: 'TSK-1',
  title: 'Task TSK-1',
  state: { id: 's-1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: ADA,
  due: null,
  priority: null,
  completedAt: null,
  revision: 7,
  rank: { number: null, score: null, calc: 'not ranked: missing ease' },
  stage: null,
  clientSet: false,
  statePosition: 2000,
  awaitingDecision: false,
};

type Sent = { readonly url: string; readonly body: Readonly<Record<string, unknown>> }[];

/** Answers the board and the people, and refuses `task.assign` as stale: somebody else changed the task first. */
const server = (sent: Sent): typeof globalThis.fetch =>
  ((url: string, init?: { body?: string }) => {
    const at = String(url);
    if (/\/live(\?|$)/u.test(at)) return Promise.resolve(new Response(null, { status: 503 }));
    if (at.endsWith('/inbox/read')) return Promise.resolve(json({ ok: true, inbox: [] }));
    if (at.endsWith('/inbox/count')) return Promise.resolve(json({ ok: true, owed: 0 }));
    const body = JSON.parse(init?.body ?? '{}') as Readonly<Record<string, unknown>>;
    sent.push({ url: at, body });
    if (at.endsWith('/task/board')) {
      return Promise.resolve(
        json({ ok: true, tasks: [TASK], changedAt: null, viewer: null, withheld: 0 }),
      );
    }
    if (at.endsWith('person/list')) return Promise.resolve(json({ ok: true, persons: [ADA, BEN] }));
    if (at.endsWith('/task/assign')) {
      return Promise.resolve(
        json(
          {
            refused: true,
            code: 'VERSION_STALE',
            names: ['assignee'],
            fixes: ['reread and try again'],
          },
          409,
        ),
      );
    }
    return Promise.resolve(json({ ok: true, recordId: TASK_ID, revision: 8, detail: {} }));
  }) as unknown as typeof globalThis.fetch;

const CELL = (key: string): string => `tr[data-row="${TASK_ID}"] td[data-key="${key}"]`;

const settleAll = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- each pass flushes the next hop
    await settle();
  }
};

describe('REVIEW-2C1-21 a refused board write is shown', () => {
  it('REVIEW-2C1-21: a VERSION_STALE refusal of task.assign is dropped; the board re-reads but never says the change was refused', async () => {
    const sent: Sent = [];
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch: server(sent),
      newOperationId: () => 'operation-1',
    });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 });
    mounted = await mount(<Projects navigate={() => {}} client={client} grantKey="alpha:ada" />);
    await settleAll();
    const reads = (): number => sent.filter((each) => each.url.endsWith('/task/board')).length;
    expect(reads()).toBe(1);

    await mounted.click(`${CELL('assignee')} button.cbd__edb`);
    const option = mounted
      .all(`${CELL('assignee')} .sel__menu [role="option"]`)
      .find((each) => each.textContent === 'Ben Ito');
    expect(option).toBeDefined();
    // eslint-disable-next-line require-await -- act's async form flushes the event's effects
    await act(async () => {
      option?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await settleAll();

    // The command went, and was refused.
    expect(sent.filter((each) => each.url.endsWith('/task/assign'))).toHaveLength(1);
    // The row is re-read: the refusal redraws the stored truth.
    expect(reads(), 'the board is re-read after the refusal').toBe(2);
    // And the person is told: the refusal's code, verbatim, in a status or an alert.
    const told = mounted
      .all('[role="status"], [role="alert"]')
      .map((each) => each.textContent ?? '')
      .filter((text) => text.includes('VERSION_STALE'));
    expect(told, 'the VERSION_STALE refusal is shown in a status or alert').not.toHaveLength(0);
  });
});
