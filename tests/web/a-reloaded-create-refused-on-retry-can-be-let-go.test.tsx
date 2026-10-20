// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A Create refused while browser storage would not write keeps its answered
// id in the stored copy, so a reload offers Retry Create under that id. The
// register replays a refusal by its operation id, and a refused replay can
// also hide a stored success the person's rights no longer release, so the
// Create stays held. The person may then stop waiting for it: the words stay
// and the next Create is a new request.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { DraftPanel } from '../../apps/web/src/screens/task/DraftPanel.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { dropOtherDrafts } from '../../apps/web/src/screens/task/task-draft.ts';
import { store } from './draft-support.tsx';
import { mount, settle, type Mounted } from '../surfaces/mount.tsx';

const PERSON = 'alpha:mia@alpha.local';

afterEach(() => dropOtherDrafts(null, null));

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Answers creates; every answer, refusal included, is kept and replayed by its operation id. */
function server() {
  const world = { granted: false, tasks: 0 };
  const register = new Map<string, { body: unknown; status: number }>();
  const held: (() => void)[] = [];
  const hold = { next: false };
  const fetch = ((_url: string | URL, init?: RequestInit) => {
    const id = String((JSON.parse(String(init?.body)) as { operationId: unknown }).operationId);
    let answer = register.get(id);
    if (answer === undefined) {
      if (world.granted) world.tasks += 1;
      answer = world.granted
        ? {
            body: {
              recordId: `10000000-0000-4000-8000-${String(world.tasks).padStart(12, '0')}`,
              revision: 1,
              detail: { key: `TSK-${String(world.tasks)}` },
            },
            status: 200,
          }
        : { body: { refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, status: 403 };
      register.set(id, answer);
    }
    const response = json(answer.body, answer.status);
    if (!hold.next) return Promise.resolve(response);
    hold.next = false;
    return new Promise<Response>((resolve) => {
      held.push(() => resolve(response));
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
  return { client, world, held, hold };
}

async function openDraft(api: ReturnType<typeof server>, storage: Storage) {
  const opened = { created: null as string | null };
  const view = await mount(
    <DraftPanel
      client={api.client}
      storage={storage}
      person={PERSON}
      scope={{ clientId: null, from: 'Projects' }}
      onCreated={(key) => (opened.created = key)}
      onClose={() => {}}
      hold={() => () => true}
    />,
  );
  await settle();
  return { view, opened };
}

const pressCreate = async (view: Mounted): Promise<void> => {
  await view.click('[data-draft="create"]');
  await settle();
  await settle();
};

async function refusedThenReloaded(storage: Storage, api: ReturnType<typeof server>) {
  const first = await openDraft(api, storage);
  await first.view.type('#panel-draft-name', 'Renew the domain');
  api.hold.next = true;
  await first.view.click('[data-draft="create"]');
  const setItem = storage.setItem.bind(storage);
  storage.setItem = () => {
    throw new DOMException('full', 'QuotaExceededError');
  };
  await act(async () => {
    api.held[0]?.();
    await Promise.resolve();
  });
  await settle();
  await settle();
  storage.setItem = setItem;
  await first.view.unmount();
  // A reload: the tab's memory is gone, its storage is not.
  dropOtherDrafts(null, null);
  api.world.granted = true;
  return openDraft(api, storage);
}

it('a reloaded Create held by its refused retry can be let go, and the next Create makes the task once', async () => {
  const storage = store();
  const api = server();
  const reloaded = await refusedThenReloaded(storage, api);
  expect(reloaded.view.find('[data-draft="let-go"]')).toBeNull();
  await pressCreate(reloaded.view);
  expect(reloaded.view.find('[data-draft-refusal]')?.textContent).toContain('may already exist');
  expect(api.world.tasks).toBe(0);
  await reloaded.view.click('[data-draft="let-go"]');
  await settle();
  expect(reloaded.view.find('[data-draft="let-go"]')).toBeNull();
  expect(reloaded.view.find('[data-draft-refusal]')).toBeNull();
  expect((reloaded.view.find('#panel-draft-name') as HTMLInputElement | null)?.value).toBe(
    'Renew the domain',
  );
  await pressCreate(reloaded.view);
  expect(reloaded.opened.created).toBe('TSK-1');
  expect(api.world.tasks).toBe(1);
  await reloaded.view.unmount();
});

it('a reloaded Create is not offered Stop waiting until its retry is refused', async () => {
  const storage = store();
  const api = server();
  const reloaded = await refusedThenReloaded(storage, api);
  expect(reloaded.view.find('[data-draft-unsettled]')).not.toBeNull();
  expect(reloaded.view.find('[data-draft="let-go"]')).toBeNull();
  api.hold.next = true;
  await reloaded.view.click('[data-draft="create"]');
  expect(reloaded.view.find('[data-draft="let-go"]'), 'never while the retry is out').toBeNull();
  await act(async () => {
    api.held.at(-1)?.();
    await Promise.resolve();
  });
  await settle();
  await settle();
  expect(reloaded.view.find('[data-draft="let-go"]')).not.toBeNull();
  await reloaded.view.unmount();
});
