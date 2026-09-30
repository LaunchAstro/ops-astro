// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Assign to AI from the Projects screen: the board read's `agent` and
// `myAgents` become the row's assignee and the assignee menu's AI entries,
// and choosing one sends `task.assign` with `agent` at the row's revision. A
// row the reader's agent holds and that is not yet in review carries the
// review tick; one already in review carries the plain one.

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

const OFFERED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HELD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const IN_REVIEW = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ADA = { personId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Ada Park' };
const AGENT = { delegationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', purpose: 'draft the menu' };

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
  agent: null,
  myAgents: [],
  ...over,
});

const TASKS = [
  task(OFFERED, 'TSK-1', { myAgents: [AGENT], revision: 7 }),
  task(HELD, 'TSK-2', {
    agent: { ...AGENT, accountable: ADA, live: true },
    myAgents: [AGENT],
  }),
  task(IN_REVIEW, 'TSK-3', {
    state: { id: 's-0', key: 'needs_review', label: 'Needs review', machineCategory: 'unstarted' },
    statePosition: 1000,
    agent: { ...AGENT, accountable: ADA, live: true },
  }),
];

type Sent = { readonly url: string; readonly body: Readonly<Record<string, unknown>> }[];

const server = (sent: Sent): typeof globalThis.fetch =>
  ((url: string, init?: { body?: string }) => {
    // The inbox the board screen mounts above the board (INB-1g), answered
    // empty and kept out of what was sent; its live stream is unavailable.
    const at = String(url);
    if (at.endsWith('/live')) return Promise.resolve(new Response(null, { status: 503 }));
    if (at.endsWith('/inbox/read')) return Promise.resolve(json({ ok: true, inbox: [] }));
    if (at.endsWith('/inbox/count')) return Promise.resolve(json({ ok: true, owed: 0 }));
    const body = JSON.parse(init?.body ?? '{}') as Readonly<Record<string, unknown>>;
    sent.push({ url: String(url), body });
    if (String(url).includes('board')) {
      return Promise.resolve(
        json({ ok: true, tasks: TASKS, changedAt: null, viewer: null, withheld: 0 }),
      );
    }
    if (String(url).endsWith('person/list')) {
      return Promise.resolve(json({ ok: true, persons: [ADA] }));
    }
    return Promise.resolve(json({ ok: true, recordId: OFFERED, revision: 8, detail: {} }));
  }) as unknown as typeof globalThis.fetch;

const CELL = (id: string, key: string): string => `tr[data-row="${id}"] td[data-key="${key}"]`;

describe('Assign to AI from the Projects screen', () => {
  it('offers the reader’s own agent on the row and sends task.assign with agent at its revision', async () => {
    const sent: Sent = [];
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch: server(sent),
      newOperationId: () => 'operation-1',
    });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 });
    mounted = await mount(<Projects client={client} grantKey="alpha:ada" />);
    await settle();
    const board = mounted;

    expect(board.all(`${CELL(HELD, 'assignee')} .cbd__nm`)[0]?.textContent).toBe('AI');
    expect(board.all(`tr[data-row="${HELD}"] input.cbd__tick`)[0]?.getAttribute('title')).toBe(
      'The agent’s work is done — send it to Needs review for your confirmation',
    );
    // Already in review, the tick completes it: no review title.
    const reviewed = board.all(`tr[data-row="${IN_REVIEW}"] input.cbd__tick`)[0];
    expect(reviewed?.getAttribute('aria-label')).toBe('Complete Task TSK-3');
    expect(reviewed?.hasAttribute('title')).toBe(false);

    await board.click(`${CELL(OFFERED, 'assignee')} button.cbd__edb`);
    const option = board
      .all(`${CELL(OFFERED, 'assignee')} .sel__menu [role="option"]`)
      .find((each) => each.textContent === 'Assign to AI: draft the menu');
    // eslint-disable-next-line require-await -- act's async form flushes the event's effects
    await act(async () => {
      option?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
    const commands = sent
      .filter((each) => !each.url.includes('board') && !each.url.endsWith('person/list'))
      .map((each) => [each.url.split('/').slice(-2).join('/'), each.body]);
    expect(commands).toStrictEqual([
      [
        'task/assign',
        {
          recordId: OFFERED,
          fields: { agent: AGENT.delegationId },
          operationId: 'operation-1',
          expectedRevision: 7,
        },
      ],
    ]);
  });
});
