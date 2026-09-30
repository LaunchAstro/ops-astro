// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-9: the board row's commands, driven from the Projects screen. The
// tick sends `task.complete` and a rename `task.update` on the title, each at
// the revision the board read for that task. The hover box's timer starts the
// reader's own clock with `time.start` (MP-4-6's command, SL08-B-2).

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

const one = (board: Mounted, selector: string): HTMLElement | null =>
  board.host.querySelector<HTMLElement>(selector);

const NAME = (id: string): string => `tr[data-row="${id}"] .cbd__nm`;
const RENAME = (id: string): string => `tr[data-row="${id}"] input.cbd__rename`;

const fire = async (target: Element | null, event: Event): Promise<void> => {
  // eslint-disable-next-line require-await -- act's async form flushes the event's effects
  await act(async () => {
    target?.dispatchEvent(event);
  });
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const TASK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const TASK = {
  id: TASK_ID,
  key: 'TSK-1',
  title: 'Task TSK-1',
  state: { id: 's-1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: null,
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

/** A server that answers the board with TASK, the people with none, and every command with success, keeping what it was sent. */
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
    // The assignee editor's people (MP-5-10): read once, never a command.
    if (String(url).endsWith('person/list'))
      return Promise.resolve(json({ ok: true, persons: [] }));
    return Promise.resolve(
      String(url).includes('board')
        ? json({ ok: true, tasks: [TASK], changedAt: null, viewer: null, withheld: 0 })
        : json({ ok: true, recordId: TASK_ID, revision: 8, detail: {} }),
    );
  }) as unknown as typeof globalThis.fetch;

describe('MP-5-9 the row’s commands from the Projects screen', () => {
  it('the tick calls task.complete and a rename task.update, each at the row’s revision', async () => {
    const sent: Sent = [];
    const fetch = server(sent);
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
    await mounted.click(`tr[data-row="${TASK_ID}"] input.cbd__tick`);
    await settle();
    await fire(
      one(mounted, NAME(TASK_ID)),
      new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
    );
    await mounted.type(RENAME(TASK_ID), 'Renamed on the board');
    await fire(
      one(mounted, RENAME(TASK_ID)),
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await settle();
    const commands = sent
      .filter((each) => !each.url.includes('board') && !each.url.endsWith('person/list'))
      .map((each) => [each.url.split('/').slice(-2).join('/'), each.body]);
    expect(commands).toStrictEqual([
      ['task/complete', { recordId: TASK_ID, operationId: 'operation-1', expectedRevision: 7 }],
      [
        'task/update',
        {
          recordId: TASK_ID,
          fields: { title: 'Renamed on the board' },
          operationId: 'operation-1',
          expectedRevision: 7,
        },
      ],
    ]);
  });
});

describe('MP-5-9 the hover box holds timer, add subtask and a door: the timer from the Projects screen', () => {
  it('the timer sends time.start on the row’s task, and no revision', async () => {
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
    await mounted.click(`tr[data-row="${TASK_ID}"] [data-route="timer"]`);
    await settle();
    const commands = sent
      .filter((each) => !each.url.includes('board') && !each.url.endsWith('person/list'))
      .map((each) => [each.url.split('/').slice(-2).join('/'), each.body]);
    expect(commands).toStrictEqual([
      ['time/start', { taskId: TASK_ID, operationId: 'operation-1' }],
    ]);
  });
});
