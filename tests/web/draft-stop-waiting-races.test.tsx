// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Stop waiting on a new-task draft held by a refused retry, raced. A Create
// whose answer was lost keeps its id; once its retry is refused the person may
// let it go, and the words stay for a new Create under a new id. It is never
// offered while a Create for that draft is out, from this mount or another,
// and a let-go id is never sent again from this tab. When storage refuses the
// rewrite, this tab mints a new id and a reload holds the old id again.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { DraftPanel } from '../../apps/web/src/screens/task/DraftPanel.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { dropOtherDrafts } from '../../apps/web/src/screens/task/task-draft.ts';
import { store } from './draft-support.tsx';
import { mount, settle, type Mounted } from '../surfaces/mount.tsx';

const PERSON = 'alpha:mia@alpha.local';

afterEach(() => dropOtherDrafts(null, null));

function hostHold(): () => boolean {
  return () => true;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Creates by id, every answer replayed by its id; `lose` drops one before the server, `hold` defers one. */
function server() {
  const world = { granted: false, tasks: 0, lose: false, hold: false };
  const register = new Map<string, { body: unknown; status: number }>();
  const sent: string[] = [];
  const held: (() => void)[] = [];
  const answer = (id: string) => {
    let known = register.get(id);
    if (known === undefined) {
      if (world.granted) world.tasks += 1;
      const n = String(world.tasks).padStart(12, '0');
      known = world.granted
        ? {
            body: {
              recordId: `10000000-0000-4000-8000-${n}`,
              revision: 1,
              detail: { key: `TSK-${String(world.tasks)}` },
            },
            status: 200,
          }
        : { body: { refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, status: 403 };
      register.set(id, known);
    }
    return json(known.body, known.status);
  };
  const fetch = ((_url: string | URL, init?: RequestInit) => {
    const id = String((JSON.parse(String(init?.body)) as { operationId: unknown }).operationId);
    sent.push(id);
    if (world.lose) {
      world.lose = false;
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    if (!world.hold) return Promise.resolve(answer(id));
    world.hold = false;
    return new Promise<Response>((resolve) => {
      held.push(() => resolve(answer(id)));
    });
  }) as unknown as typeof globalThis.fetch;
  let minted = 0;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
    newOperationId: () => `22222222-2222-4222-8222-${String((minted += 1)).padStart(12, '0')}`,
  });
  // Each world its own host hold, so no flight outlives its test.
  const hold = hostHold.bind(null);
  return { client, world, sent, held, hold };
}
type Api = ReturnType<typeof server>;

async function open(api: Api, storage: Storage) {
  const opened = { created: null as string | null };
  const view = await mount(
    <DraftPanel
      client={api.client}
      storage={storage}
      person={PERSON}
      scope={{ clientId: null, from: 'Projects' }}
      onCreated={(key) => (opened.created = key)}
      onClose={() => {}}
      hold={api.hold}
    />,
  );
  await settle();
  return { view, opened };
}

const flush = async (): Promise<void> => {
  for (let round = 0; round < 4; round += 1) {
    // eslint-disable-next-line no-await-in-loop -- one settle at a time
    await settle();
  }
};
const press = async (view: Mounted, what: string): Promise<void> => {
  await view.click(`[data-draft="${what}"]`);
  await flush();
};
const release = async (api: Api): Promise<void> => {
  await act(async () => {
    api.held.shift()?.();
    await Promise.resolve();
  });
  await flush();
};

/** A Create lost before the server, then its retry refused: Stop waiting is offered. */
async function heldAndRefused(api: Api, storage: Storage) {
  const first = await open(api, storage);
  await first.view.type('#panel-draft-name', 'Renew the domain');
  api.world.lose = true;
  await press(first.view, 'create');
  await press(first.view, 'create');
  expect(first.view.find('[data-draft="let-go"]')).not.toBeNull();
  return first;
}

it('a remount while the retry is out offers Stop waiting only once the refusal lands', async () => {
  const storage = store();
  const api = server();
  const first = await open(api, storage);
  await first.view.type('#panel-draft-name', 'Renew the domain');
  api.world.lose = true;
  await press(first.view, 'create');
  api.world.hold = true;
  await first.view.click('[data-draft="create"]');
  await first.view.unmount();
  const again = await open(api, storage);
  expect(again.view.find('[data-draft="let-go"]'), 'the retry is still out').toBeNull();
  await release(api);
  await press(again.view, 'let-go');
  api.world.granted = true;
  await press(again.view, 'create');
  expect(again.opened.created).toBe('TSK-1');
  expect(new Set(api.sent).size, 'the let-go id, then one new id').toBe(2);
});

it('a mount does not offer Stop waiting while another mount retries the same Create', async () => {
  const storage = store();
  const api = server();
  const first = await heldAndRefused(api, storage);
  const other = await open(api, storage);
  api.world.hold = true;
  await other.view.click('[data-draft="create"]');
  expect(first.view.find('[data-draft="let-go"]'), 'the other mount is retrying').toBeNull();
  await release(api);
});

it('a Create let go on one mount is not sent again from another mount', async () => {
  const storage = store();
  const api = server();
  const first = await heldAndRefused(api, storage);
  const other = await open(api, storage);
  const letGo = api.sent[0];
  await press(first.view, 'let-go');
  api.world.granted = true;
  await press(other.view, 'create');
  expect(api.sent.slice(2), 'the let-go id is not sent again').not.toContain(letGo);
});

it('Stop waiting the browser cannot save mints a new id in this tab', async () => {
  const storage = store();
  const api = server();
  const first = await heldAndRefused(api, storage);
  const setItem = storage.setItem.bind(storage);
  storage.setItem = () => {
    throw new DOMException('full', 'QuotaExceededError');
  };
  await press(first.view, 'let-go');
  expect(first.view.find('[data-draft="let-go"]')).toBeNull();
  expect((first.view.find('#panel-draft-name') as HTMLInputElement).value).toBe('Renew the domain');
  await press(first.view, 'create');
  expect(api.sent, 'a Create storage cannot keep is not sent').toHaveLength(2);
  storage.setItem = setItem;
  api.world.granted = true;
  await press(first.view, 'create');
  expect(first.opened.created).toBe('TSK-1');
  expect(api.sent).toHaveLength(3);
  expect(api.sent[2]).not.toBe(api.sent[0]);
});

it('Stop waiting the browser cannot save holds the old id again after a reload', async () => {
  const storage = store();
  const api = server();
  const first = await heldAndRefused(api, storage);
  storage.setItem = () => {
    throw new DOMException('full', 'QuotaExceededError');
  };
  await press(first.view, 'let-go');
  await first.view.unmount();
  dropOtherDrafts(null, null);
  const reloaded = await open(api, storage);
  expect(reloaded.view.find('[data-draft-unsettled]')).not.toBeNull();
  await press(reloaded.view, 'create');
  expect(api.sent).toEqual([api.sent[0], api.sent[0], api.sent[0]]);
  expect(api.world.tasks).toBe(0);
});
