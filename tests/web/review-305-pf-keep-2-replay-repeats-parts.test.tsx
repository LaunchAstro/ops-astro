// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// review/305-pf-keep-2: the stored create identity is kept while Create's
// parts are still being written. A reload after the task and its subtask
// landed, but before Create finished, reopens the draft with the same
// identity; Create then replays the task and writes every part again, so the
// subtask (and the time, which has no revision to go stale on) is written
// twice on the one task.

import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { json, press, typeInto, unmountAll } from './perspective-support.tsx';
import { NEW_ID, NEW_KEY, create, draft, store, type Sent } from './draft-support.tsx';

afterEach(unmountAll);

/** The task and its subtask land; the first time.log never answers (the tab reloads). */
function server() {
  const sent: Sent[] = [];
  let logs = 0;
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const to = String(url).replace(/^.*?(\/[a-z]+\/[a-z_]+)$/u, '$1');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'];
    sent.push({ to, body });
    if (to === '/task/create' && body['parentId'] === undefined) {
      // The same identity replays the first answer.
      return Promise.resolve(json({ recordId: NEW_ID, revision: 1, detail: { key: NEW_KEY } }));
    }
    if (to === '/time/log') {
      logs += 1;
      if (logs === 1) {
        return new Promise<Response>(() => {
          /* the tab reloaded before it answered */
        });
      }
    }
    return Promise.resolve(json({ recordId: 's-1', revision: 2, detail: {} }));
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    subtasks: () =>
      sent.filter((one) => one.to === '/task/create' && one.body['parentId'] !== undefined),
    creates: () =>
      sent.filter((one) => one.to === '/task/create' && one.body['parentId'] === undefined),
  };
}

describe('review/305-pf-keep-2 a replayed create after a reload', () => {
  it('does not write again the subtask that already landed on the task', async () => {
    const storage = store();
    const api = server();
    const opened = await draft({ client: api.client, storage });
    await typeInto(opened.view, '#panel-draft-name', 'New brief');
    await typeInto(opened.view, '#panel-draft-steps', 'Call the client');
    await press(opened.view, '#panel-draft-steps', 'Enter');
    await typeInto(opened.view, '#panel-draft-time', '30m');
    await create(opened.view);
    expect(api.subtasks(), 'the first Create wrote its subtask').toHaveLength(1);
    await opened.view.unmount();

    const again = await draft({ client: api.client, storage });
    await create(again.view);
    const [first, second] = api.creates().map((one) => one.body['operationId']);
    expect(second, 'the reopened draft replays the same create').toBe(first);
    expect(
      api.subtasks(),
      'the replayed create wrote the landed subtask a second time',
    ).toHaveLength(1);
  });
});
