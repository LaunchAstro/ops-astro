// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-17b: the create's identity stays with the kept draft. A reload,
// browser Back or a hard navigation unmounts the draft panel without the
// host holding it, while its Create is out or after an answer nobody knows.
// The kept draft then reopens from storage, and its Create must be sent under
// the same operation id, so the server replays the first task rather than
// making a second. An edit to the reopened draft is a new request, with a new
// identity, as before.

import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { json, typeInto, unmountAll } from './perspective-support.tsx';
import { dropOtherDrafts } from '../../apps/web/src/screens/task/task-draft.ts';
import { NEW_ID, NEW_KEY, create, draft, store, type Sent } from './draft-support.tsx';

afterEach(async () => {
  await unmountAll();
  dropOtherDrafts(null, null);
});

/** A server whose first top-level create never answers, or fails on the wire; later ones answer. */
function server(first: 'pending' | 'unknown') {
  const sent: Sent[] = [];
  let creates = 0;
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const to = String(url).replace(/^.*?(\/[a-z]+\/[a-z_]+)$/u, '$1');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'];
    sent.push({ to, body });
    if (to === '/task/create' && body['parentId'] === undefined) {
      creates += 1;
      if (creates === 1) {
        return first === 'pending'
          ? new Promise<Response>(() => {
              /* the tab went away before it answered */
            })
          : Promise.reject(new TypeError('network down'));
      }
      return Promise.resolve(json({ recordId: NEW_ID, revision: 1, detail: { key: NEW_KEY } }));
    }
    if (to === '/time/log')
      return Promise.resolve(
        json({
          recordId: null,
          revision: null,
          detail: { entryId: '77777777-7777-4777-8777-777777777777', minutes: 30 },
        }),
      );
    return Promise.resolve(json({ recordId: NEW_ID, revision: 2, detail: {} }));
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    identities: (): unknown[] =>
      sent
        .filter((one) => one.to === '/task/create' && one.body['parentId'] === undefined)
        .map((one) => one.body['operationId']),
  };
}

/** Fill a draft, press Create, then unmount the panel as a reload would. */
async function startAndLeave(first: 'pending' | 'unknown', storage: Storage) {
  const api = server(first);
  const opened = await draft({ client: api.client, storage });
  await typeInto(opened.view, '#panel-draft-name', 'New brief');
  await typeInto(opened.view, '#panel-draft-time', '30m');
  await create(opened.view);
  expect(api.identities()).toHaveLength(1);
  await opened.view.unmount();
  return api;
}

describe('REVIEW-2C1-17b the create identity is kept with the draft', () => {
  it('REVIEW-2C1-17b: a draft reopened while its Create is still out sends Create under the same operation id', async () => {
    const storage = store();
    const api = await startAndLeave('pending', storage);
    const again = await draft({ client: api.client, storage });
    await create(again.view);
    const [first, second] = api.identities();
    expect(api.identities()).toHaveLength(2);
    expect(second, 'the reopened draft minted a new operation id').toBe(first);
    expect(again.outcome.created).toBe(NEW_KEY);
  });

  it('REVIEW-2C1-17b: a draft reopened after an unknown outcome sends Create under the same operation id', async () => {
    const storage = store();
    const api = await startAndLeave('unknown', storage);
    const again = await draft({ client: api.client, storage });
    await create(again.view);
    const [first, second] = api.identities();
    expect(second, 'the reopened draft minted a new operation id').toBe(first);
  });

  it('REVIEW-2C1-17b: an edit to the reopened draft starts a new attempt', async () => {
    const storage = store();
    const api = await startAndLeave('pending', storage);
    const again = await draft({ client: api.client, storage });
    await typeInto(again.view, '#panel-draft-name', 'New brief for the client');
    await create(again.view);
    const [first, second] = api.identities();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });
});

it('an unknown Create keeps its operation id through a remount with blocked storage', async () => {
  const storage: Storage = {
    ...store(),
    getItem: () => {
      throw new DOMException('Storage blocked', 'SecurityError');
    },
    setItem: () => {
      throw new DOMException('Storage blocked', 'SecurityError');
    },
  };
  const api = await startAndLeave('unknown', storage);
  const again = await draft({ client: api.client, storage });
  await create(again.view);
  const [first, second] = api.identities();
  expect(api.identities()).toHaveLength(2);
  expect(second, 'the reopened draft minted a new operation id').toBe(first);
  expect(again.outcome.created).toBe(NEW_KEY);
});
