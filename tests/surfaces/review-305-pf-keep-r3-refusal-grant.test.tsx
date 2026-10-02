// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// review/305-pf-keep security review S4: the board's refusal line belongs to
// the grant the write was sent under. A business switch clears it, and a
// refusal that answers after the switch is never drawn on the new board.

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
const server = (sent: Sent, held?: (() => void)[]): typeof globalThis.fetch =>
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
      const refusal = (): Response =>
        json(
          {
            refused: true,
            code: 'VERSION_STALE',
            names: ['assignee'],
            fixes: ['reread and try again'],
          },
          409,
        );
      if (held === undefined) return Promise.resolve(refusal());
      return new Promise<Response>((resolve) => {
        held.push(() => {
          resolve(refusal());
        });
      });
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

const board = (client: OperationsClient, grantKey: string) => (
  <Projects navigate={() => {}} client={client} grantKey={grantKey} />
);

const assignBen = async (view: Mounted): Promise<void> => {
  await view.click(`${CELL('assignee')} button.cbd__edb`);
  const option = view
    .all(`${CELL('assignee')} .sel__menu [role="option"]`)
    .find((each) => each.textContent === 'Ben Ito');
  // eslint-disable-next-line require-await -- act's async form flushes the event's effects
  await act(async () => {
    option?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settleAll();
};

const told = (view: Mounted): string[] =>
  view
    .all('[role="alert"]')
    .map((each) => each.textContent ?? '')
    .filter((text) => text.includes('VERSION_STALE'));

const opened = async (held?: (() => void)[]) => {
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: server([], held),
    newOperationId: () => 'operation-1',
  });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 });
  mounted = await mount(board(client, 'alpha:ada'));
  await settleAll();
  return { client, view: mounted };
};

describe('review/305-pf-keep S4 the board refusal and the grant', () => {
  it('S4: a business switch clears the refusal line', async () => {
    const { client, view } = await opened();
    await assignBen(view);
    expect(told(view)).not.toHaveLength(0);
    await view.render(board(client, 'beta:ada'));
    await settleAll();
    expect(told(view), "business A's refusal is drawn on business B's board").toHaveLength(0);
  });

  it('S4: a refusal that answers after a business switch is not drawn on the new board', async () => {
    const held: (() => void)[] = [];
    const { client, view } = await opened(held);
    await assignBen(view);
    await view.render(board(client, 'beta:ada'));
    await settleAll();
    for (const answer of held.splice(0)) answer();
    await settleAll();
    expect(told(view), "business A's late refusal is drawn on business B's board").toHaveLength(0);
  });
});
