// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// #461's held operation ids belong to one task page: one business, one task,
// one signed-in person. A subtask add or a time log whose answer was lost on
// one page is never retried under its id from another. Each crossing renders
// the destination under its own business, task or grant, submits the same
// words, and the request goes out under a fresh id to the destination's task
// and business.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { json, mount, press, unmountAll } from './perspective-support.tsx';
import { task, tick } from './task-page-stub.tsx';

afterEach(unmountAll);

interface Sent {
  readonly url: string;
  readonly body: Readonly<Record<string, unknown>>;
}

const KEY = 'Proj-Verity-Pacing';
const OTHER = 'Proj-Other-Client';
const IDS: Readonly<Record<string, string>> = {
  [KEY]: '33333333-3333-4333-8333-333333333333',
  [OTHER]: '55555555-5555-4555-8555-555555555555',
};

const KINDS = [
  { kind: 'subtask', path: '/task/create', selector: '[data-step-add]', typed: 'One child' },
  { kind: 'time log', path: '/time/log', selector: '[data-time-log]', typed: '30m' },
] as const;

/** Every write recorded; the first answer is lost after it was sent. */
function clientFor(businessKey: string, writes: Sent[], path: string): OperationsClient {
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'];
    if (at.endsWith('/task/read')) {
      const key = String(body['recordId']);
      const time = { entries: [], totalMinutes: 0, running: null };
      return Promise.resolve(json({ ok: true, task: task({ id: IDS[key], key, time }) }));
    }
    if (at.endsWith(path)) {
      writes.push({ url: at, body });
      if (writes.length === 1) return Promise.reject(new TypeError('Response lost'));
      return Promise.resolve(json({ recordId: 'made', revision: 1 }));
    }
    return Promise.resolve(json({ ok: true, persons: [], preferences: {}, items: [] }));
  }) as unknown as typeof globalThis.fetch;
  return new OperationsClient({ origin: '', businessKey, signedIn: true, fetch });
}

const targetOf = (sent: Sent | undefined): unknown =>
  sent?.body['taskId'] ?? sent?.body['parentId'];

const CROSSINGS = [
  { crossing: 'business to business', to: { business: 'bravo', grant: 'bravo:ada', key: KEY } },
  {
    crossing: 'client task to client task',
    to: { business: 'alpha', grant: 'alpha:ada', key: OTHER },
  },
  { crossing: 'person to person', to: { business: 'alpha', grant: 'alpha:noah', key: KEY } },
] as const;

describe('a held operation never crosses a business, a client task or a person', () => {
  for (const { kind, path, selector, typed } of KINDS) {
    it.each(CROSSINGS)(
      `a lost ${kind}, then $crossing: a fresh operation to the destination`,
      async ({ to }) => {
        const writes: Sent[] = [];
        const alpha = clientFor('alpha', writes, path);
        const destination = to.business === 'alpha' ? alpha : clientFor(to.business, writes, path);
        const view = await mount(
          <TaskDetailScreen client={alpha} grantKey="alpha:ada" taskKey={KEY} />,
        );
        await tick();
        await vi.waitFor(() => expect(view.host.querySelector(selector)).not.toBeNull());
        await view.type(selector, typed);
        await press(view, selector, 'Enter');
        await vi.waitFor(() => expect(writes).toHaveLength(1));
        await tick();

        await view.render(
          <TaskDetailScreen client={destination} grantKey={to.grant} taskKey={to.key} />,
        );
        await tick();
        await vi.waitFor(() => expect(view.host.querySelector(selector)).not.toBeNull());
        await view.type(selector, typed);
        await press(view, selector, 'Enter');
        await vi.waitFor(() => expect(writes).toHaveLength(2));
        expect(writes[1]?.body['operationId'], 'the lost write’s id crossed').not.toBe(
          writes[0]?.body['operationId'],
        );
        expect(targetOf(writes[1])).toBe(IDS[to.key]);
        expect(writes[1]?.url).toContain(`/b/${to.business}/`);
      },
    );
  }
});
