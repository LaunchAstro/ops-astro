// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// #461, the reread a live channel does not drive: a write in the dock panel
// moves the host's change count, and the task page reads again as a new read,
// which remounts what is under it. A subtask or time log whose answer was
// lost before that must keep its operation id through it, so the retry of the
// same request is the same write and the server keeps one record.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { json, mount, press, unmountAll } from './perspective-support.tsx';
import { task, tick } from './task-page-stub.tsx';

afterEach(unmountAll);

const KEY = 'Proj-Verity-Pacing';

const CASES = [
  { kind: 'subtask', path: '/task/create', selector: '[data-step-add]', typed: 'One child' },
  { kind: 'time log', path: '/time/log', selector: '[data-time-log]', typed: '30m' },
] as const;

describe('a lost write keeps its operation through a change-count reread', () => {
  it.each(CASES)(
    'a lost $kind answer, then a write elsewhere: the retry goes under the same operation',
    async ({ path, selector, typed }) => {
      const identities: unknown[] = [];
      const fetch = ((url: string | URL, init?: RequestInit) => {
        const at = String(url);
        if (at.endsWith('/task/read')) {
          const time = { entries: [], totalMinutes: 0, running: null };
          return Promise.resolve(json({ ok: true, task: task({ time }) }));
        }
        if (at.endsWith(path)) {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          identities.push(body['operationId']);
          if (identities.length === 1) return Promise.reject(new TypeError('Response lost'));
          return Promise.resolve(json({ recordId: 'made', revision: 1 }));
        }
        return Promise.resolve(json({ ok: true, persons: [], preferences: {}, items: [] }));
      }) as unknown as typeof globalThis.fetch;
      const client = new OperationsClient({
        origin: '',
        businessKey: 'alpha',
        signedIn: true,
        fetch,
      });
      const screen = (changes: number) => (
        <TaskDetailScreen client={client} grantKey="alpha:member" taskKey={KEY} changes={changes} />
      );
      const view = await mount(screen(0));
      await tick();
      await vi.waitFor(() => expect(view.host.querySelector(selector)).not.toBeNull());
      await view.type(selector, typed);
      await press(view, selector, 'Enter');
      await vi.waitFor(() => expect(identities).toHaveLength(1));
      await tick();

      await view.render(screen(1));
      await tick();
      await vi.waitFor(() => expect(view.host.querySelector(selector)).not.toBeNull());
      await view.type(selector, typed);
      await press(view, selector, 'Enter');
      await vi.waitFor(() => expect(identities).toHaveLength(2));
      expect(identities[1], 'the reread dropped the lost write’s operation').toBe(identities[0]);
    },
  );
});

/** A page whose writes to `path` answer only when the test says, in order. */
function heldServer(path: string) {
  const writes: Readonly<Record<string, unknown>>[] = [];
  const answers: ((outcome: 'ok' | 'lost') => void)[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (at.endsWith('/task/read')) {
      const time = { entries: [], totalMinutes: 0, running: null };
      return Promise.resolve(json({ ok: true, task: task({ time }) }));
    }
    if (at.endsWith(path)) {
      writes.push(JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>);
      return new Promise<Response>((resolve, reject) => {
        answers.push((outcome) => {
          if (outcome === 'lost') reject(new TypeError('Response lost'));
          else resolve(json({ recordId: 'made', revision: 1 }));
        });
      });
    }
    return Promise.resolve(json({ ok: true, persons: [], preferences: {}, items: [] }));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { client, writes, answers };
}

const opOf = (body: Readonly<Record<string, unknown>> | undefined): unknown =>
  body?.['operationId'];

/**
 * Sol's sequence: A is sent and held, the page remounts and A is replayed and
 * held, A lands, a new write B is lost, A's replay lands late from a box long
 * gone, and B is retried. The writes, in order.
 */
async function lateAnswerWrites(c: (typeof CASES)[number]) {
  const server = heldServer(c.path);
  const screen = (changes: number) => (
    <TaskDetailScreen
      client={server.client}
      grantKey="alpha:member"
      taskKey={KEY}
      changes={changes}
    />
  );
  const view = await mount(screen(0));
  const send = async (): Promise<void> => {
    await vi.waitFor(() => expect(view.host.querySelector(c.selector)).not.toBeNull());
    await view.type(c.selector, c.typed);
    await press(view, c.selector, 'Enter');
  };
  const answer = async (at: number, outcome: 'ok' | 'lost'): Promise<void> => {
    server.answers[at]?.(outcome);
    await tick();
  };
  const remount = async (changes: number): Promise<void> => {
    await view.render(screen(changes));
    await tick();
  };
  await tick();
  await send();
  await remount(1);
  await send();
  await answer(0, 'ok');
  await remount(2);
  await send();
  await answer(2, 'lost');
  await answer(1, 'ok');
  await remount(3);
  await send();
  await vi.waitFor(() => expect(server.writes).toHaveLength(4));
  return server.writes;
}

describe('a late answer and another box never release the wrong held operation', () => {
  it.each(CASES)(
    'a late $kind answer from a remounted box leaves a newer lost operation held',
    async (c) => {
      const writes = await lateAnswerWrites(c);
      expect(opOf(writes[1]), 'the replay of A').toBe(opOf(writes[0]));
      expect(opOf(writes[2]), 'B is a new write').not.toBe(opOf(writes[0]));
      expect(opOf(writes[3]), 'a late answer released the newer lost write').toBe(opOf(writes[2]));
    },
  );

  it('a refused time log whose words match a lost subtask’s key leaves the subtask’s operation held', async () => {
    const subtasks = heldServer('/task/create');
    const view = await mount(
      <TaskDetailScreen client={subtasks.client} grantKey="alpha:member" taskKey={KEY} />,
    );
    await tick();
    await vi.waitFor(() => expect(view.host.querySelector('[data-step-add]')).not.toBeNull());
    await view.type('[data-step-add]', 'One child');
    await press(view, '[data-step-add]', 'Enter');
    subtasks.answers[0]?.('lost');
    await tick();
    const lost = opOf(subtasks.writes[0]);
    // The time log is answered at once, and any definitive answer releases its
    // key (a reused id with another payload is refused, OPERATION_ID_REUSED).
    const words = JSON.stringify({ fields: { title: 'One child' }, parentId: task().id });
    await view.type('[data-time-log]', words);
    await press(view, '[data-time-log]', 'Enter');
    await tick();
    await view.type('[data-step-add]', 'One child');
    await press(view, '[data-step-add]', 'Enter');
    await vi.waitFor(() => expect(subtasks.writes).toHaveLength(2));
    expect(opOf(subtasks.writes[1]), 'the time log released the subtask’s id').toBe(lost);
  });
});
