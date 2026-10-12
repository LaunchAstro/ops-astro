// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A Create that made its task drops the draft; a draft the browser would not
// remove keeps its create's id, so the reopened draft replays that task rather
// than making a second. Raced here: two tabs retrying one held Create, the
// answer lost before and after the server stored it, the answer landing on a
// remounted panel, and a refusal, which must leave no id held. The server
// replays a create by its operation id, as the real register does.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { DraftPanel } from '../../apps/web/src/screens/task/DraftPanel.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { dropOtherDrafts } from '../../apps/web/src/screens/task/task-draft.ts';
import { store } from './draft-support.tsx';
import { mount, settle, type Mounted } from '../surfaces/mount.tsx';

const PERSON = 'alpha:mia@alpha.local';
const DRAFT_KEY = `ops-astro.task-draft.${PERSON}`;
const FIRST_ID = '22222222-2222-4222-8222-000000000001';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const REFUSED = { refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] };

/** What the next create meets; `hold` keeps each answer back until a test releases it. */
interface Next {
  unreachable: boolean;
  lose: boolean;
  refuse: boolean;
  hold: boolean;
}

function server() {
  const tasks: string[] = [];
  const creates: string[] = [];
  const held: (() => void)[] = [];
  const next: Next = { unreachable: false, lose: false, refuse: false, hold: false };
  const answer = (response: Response): Promise<Response> =>
    next.hold
      ? new Promise<Response>((resolve) => {
          held.push(() => resolve(response));
        })
      : Promise.resolve(response);
  const fetch = ((_url: string | URL, init?: RequestInit) => {
    const id = String((JSON.parse(String(init?.body)) as { operationId: unknown }).operationId);
    if (next.unreachable) {
      next.unreachable = false;
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    creates.push(id);
    if (next.refuse) {
      next.refuse = false;
      return answer(json(REFUSED, 403));
    }
    if (!tasks.includes(id)) tasks.push(id);
    if (next.lose) {
      next.lose = false;
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    const at = tasks.indexOf(id) + 1;
    const recordId = `11111111-1111-4111-8111-${String(at).padStart(12, '0')}`;
    return answer(json({ recordId, revision: 1, detail: { key: `TSK-${String(at)}` } }));
  }) as unknown as typeof globalThis.fetch;
  let minted = 0;
  const newOperationId = (): string => {
    minted += 1;
    return `22222222-2222-4222-8222-${String(minted).padStart(12, '0')}`;
  };
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
    newOperationId,
  });
  return { client, tasks, creates, held, next };
}

type Api = ReturnType<typeof server>;

/** One host's hold: a remount under it finds the Create still out. */
const sameHost = (): (() => boolean) => () => true;

async function openDraft(api: Api, storage: Storage, hold: () => () => boolean = () => () => true) {
  const opened = { created: null as string | null };
  const view = await mount(
    <DraftPanel
      client={api.client}
      storage={storage}
      person={PERSON}
      scope={{ clientId: null, from: 'Projects' }}
      onCreated={(key) => (opened.created = key)}
      onClose={() => {}}
      hold={hold}
    />,
  );
  await settle();
  return { view, opened };
}

/** The browser refuses to remove the kept draft, as a locked-down profile can. */
const refuseRemoval = (storage: Storage): void => {
  storage.removeItem = () => {
    throw new DOMException('denied', 'SecurityError');
  };
};

/** A duplicated tab starts with a copy of this tab's storage. */
function duplicate(from: Storage): Storage {
  const copy = store();
  for (let index = 0; index < from.length; index += 1) {
    const key = from.key(index);
    if (key !== null) copy.setItem(key, from.getItem(key) ?? '');
  }
  return copy;
}

/** The create id kept with the draft in `storage`, or null. */
const heldId = (storage: Storage): string | null =>
  (JSON.parse(storage.getItem(DRAFT_KEY) ?? '{}') as { attempt?: { id?: string } }).attempt?.id ??
  null;

const createLabel = (view: Mounted): string | null | undefined =>
  view.find('[data-draft="create"]')?.textContent;

const pressCreate = async (view: Mounted): Promise<void> => {
  await view.click('[data-draft="create"]');
  await settle();
  await settle();
};

/** Answers the held create at `index`, then lets the panel draw it. */
const release = async (api: Api, index: number): Promise<void> => {
  await act(async () => {
    api.held[index]?.();
    await Promise.resolve();
  });
  await settle();
  await settle();
};

/** A Create the server stored whose answer was lost: the draft is left holding its id. */
async function storedAnswerLost(api: Api, storage: Storage): Promise<void> {
  const first = await openDraft(api, storage);
  await first.view.type('#panel-draft-name', 'Renew the domain');
  api.next.lose = true;
  await pressCreate(first.view);
  await first.view.unmount();
}

async function reopenAndRetry(api: Api, storage: Storage): Promise<string | null> {
  const again = await openDraft(api, storage);
  expect(createLabel(again.view)).toBe('Retry Create');
  await pressCreate(again.view);
  await again.view.unmount();
  return again.opened.created;
}

describe('two tabs retrying one held Create, the removal refused in one', () => {
  it.each([
    ['in the order sent', 0, 1],
    ['in the reverse order', 1, 0],
  ])(
    'answered %s, make one task and the tab that could not drop it keeps the id',
    async (_, x, y) => {
      const one = store();
      const api = server();
      await storedAnswerLost(api, one);
      const two = duplicate(one);
      refuseRemoval(one);
      const a = await openDraft(api, one);
      const b = await openDraft(api, two);
      api.next.hold = true;
      await a.view.click('[data-draft="create"]');
      await b.view.click('[data-draft="create"]');
      expect(api.held).toHaveLength(2);
      await release(api, x);
      await release(api, y);
      expect(new Set(api.creates)).toStrictEqual(new Set([FIRST_ID]));
      expect(api.tasks).toHaveLength(1);
      expect([a.opened.created, b.opened.created]).toStrictEqual(['TSK-1', 'TSK-1']);
      expect(heldId(one)).toBe(FIRST_ID);
      expect(two.getItem(DRAFT_KEY)).toBeNull();
    },
  );
});

describe('a held Create whose answer is lost, then created with the removal refused', () => {
  it('lost before it reached the server: the retry sends the same id and keeps it', async () => {
    const storage = store();
    const api = server();
    const { view, opened } = await openDraft(api, storage);
    await view.type('#panel-draft-name', 'Renew the domain');
    api.next.unreachable = true;
    await pressCreate(view);
    expect(createLabel(view)).toBe('Retry Create');
    refuseRemoval(storage);
    await pressCreate(view);
    expect(opened.created).toBe('TSK-1');
    expect(api.creates).toStrictEqual([FIRST_ID]);
    expect(heldId(storage)).toBe(FIRST_ID);
    await view.unmount();
  });

  it('lost after the server stored it: every reopen replays the one task', async () => {
    const storage = store();
    const api = server();
    await storedAnswerLost(api, storage);
    refuseRemoval(storage);
    expect(await reopenAndRetry(api, storage)).toBe('TSK-1');
    expect(await reopenAndRetry(api, storage)).toBe('TSK-1');
    expect(api.creates).toStrictEqual([FIRST_ID, FIRST_ID, FIRST_ID]);
    expect(api.tasks).toHaveLength(1);
  });
});

describe('a created answer that lands on a remounted panel, the removal refused', () => {
  it('leaves the new mount holding the same id for Retry', async () => {
    const storage = store();
    const api = server();
    const first = await openDraft(api, storage, sameHost);
    await first.view.type('#panel-draft-name', 'Renew the domain');
    refuseRemoval(storage);
    api.next.hold = true;
    await first.view.click('[data-draft="create"]');
    await first.view.unmount();
    const second = await openDraft(api, storage, sameHost);
    expect((second.view.find('[data-draft="create"]') as HTMLButtonElement | null)?.disabled).toBe(
      true,
    );
    await release(api, 0);
    expect(first.opened.created).toBe('TSK-1');
    expect(createLabel(second.view)).toBe('Retry Create');
    api.next.hold = false;
    await pressCreate(second.view);
    expect(second.opened.created).toBe('TSK-1');
    expect(api.creates).toStrictEqual([FIRST_ID, FIRST_ID]);
    expect(api.tasks).toHaveLength(1);
    await second.view.unmount();
  });
});

describe('a refused Create', () => {
  it('leaves no held id when the draft cannot be removed, so the next Create is new', async () => {
    const storage = store();
    const api = server();
    const { view } = await openDraft(api, storage);
    await view.type('#panel-draft-name', 'Renew the domain');
    refuseRemoval(storage);
    api.next.refuse = true;
    await pressCreate(view);
    expect(createLabel(view)).toBe('Create task');
    expect(heldId(storage)).toBeNull();
    await pressCreate(view);
    expect(api.creates).toHaveLength(2);
    expect(api.creates[1]).not.toBe(FIRST_ID);
    await view.unmount();
  });

  it('settled while storage would not write keeps the words, and one Retry settles it under its id', async () => {
    const storage = store();
    const api = server();
    const { view } = await openDraft(api, storage);
    await view.type('#panel-draft-name', 'Renew the domain');
    api.next.refuse = true;
    api.next.hold = true;
    await view.click('[data-draft="create"]');
    const setItem = storage.setItem.bind(storage);
    storage.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    await release(api, 0);
    expect(createLabel(view)).toBe('Create task');
    storage.setItem = setItem;
    await view.unmount();
    // A reload: the tab's memory is gone, its storage is not.
    dropOtherDrafts(null, null);
    api.next.hold = false;
    const reloaded = await openDraft(api, storage);
    expect((reloaded.view.find('#panel-draft-name') as HTMLInputElement).value).toBe(
      'Renew the domain',
    );
    // The answered id could not be cleared, so the reload offers it once more.
    expect(createLabel(reloaded.view)).toBe('Retry Create');
    const first = api.creates[0];
    await reloaded.view.click('[data-draft="create"]');
    await settle();
    await settle();
    expect(api.creates).toEqual([first, first]);
    expect(api.tasks).toHaveLength(1);
    expect(heldId(storage)).toBeNull();
    await reloaded.view.unmount();
  });
});
