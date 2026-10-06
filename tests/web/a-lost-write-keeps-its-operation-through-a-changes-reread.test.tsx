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

describe('#461 a lost write keeps its operation through a change-count reread', () => {
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
