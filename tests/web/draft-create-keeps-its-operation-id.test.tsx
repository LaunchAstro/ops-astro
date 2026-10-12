// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A Create keeps its operation id until its outcome is known, so no retry,
// reload or upgrade makes the task twice. The server below replays a create
// by its operation id, as the real register does, and can withhold the
// replay (the person's authority withdrawn) or lose the answer after it
// commits.

import { describe, expect, it } from 'vitest';
import { DraftPanel } from '../../apps/web/src/screens/task/DraftPanel.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { sessionGeneration } from '../../apps/web/src/session/token.ts';
import { store } from './draft-support.tsx';
import { mount, settle } from '../surfaces/mount.tsx';

const PERSON = 'alpha:mia@alpha.local';
const DRAFT_KEY = `ops-astro.task-draft.${PERSON}`;
const FORMER_KEY = 'ops-astro.create-attempts';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function server(storage: Storage) {
  const tasks: string[] = [];
  const register = new Map<string, unknown>();
  const creates: string[] = [];
  /** The attempt kept with the draft when each create arrived. */
  const keptAtSend: (string | null)[] = [];
  const next = { drop: false, refuse: false };
  const fetch = ((_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const operationId = String(body['operationId']);
    creates.push(operationId);
    const kept = JSON.parse(storage.getItem(DRAFT_KEY) ?? '{}') as { attempt?: { id: string } };
    keptAtSend.push(kept.attempt?.id ?? null);
    if (next.refuse) {
      next.refuse = false;
      return Promise.resolve(
        json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403),
      );
    }
    if (!register.has(operationId)) {
      tasks.push(operationId);
      register.set(operationId, {
        recordId: `11111111-1111-4111-8111-${String(tasks.length).padStart(12, '0')}`,
        revision: 1,
        detail: { key: `TSK-${String(tasks.length)}` },
      });
    }
    if (next.drop) {
      next.drop = false;
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    return Promise.resolve(json(register.get(operationId)));
  }) as unknown as typeof globalThis.fetch;
  let minted = 0;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
    newOperationId: () => {
      minted += 1;
      return `22222222-2222-4222-8222-${String(minted).padStart(12, '0')}`;
    },
  });
  return { client, tasks, creates, keptAtSend, next };
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

describe('a create whose replay is refused', () => {
  it('keeps its operation id, so the next Create replays it and one task exists', async () => {
    const storage = store();
    const api = server(storage);
    const { view, opened } = await openDraft(api, storage);
    await view.type('#panel-draft-name', 'Renew the domain');
    api.next.drop = true;
    await view.click('[data-draft="create"]');
    await settle();
    expect(api.tasks).toHaveLength(1);

    // Authority withdrawn: the replay is withheld, which proves nothing about the first.
    api.next.refuse = true;
    await view.click('[data-draft="create"]');
    await settle();
    expect(view.find('[data-draft="create"]')?.textContent).toBe('Retry Create');
    expect(view.text()).toContain('check the board');

    // Authority restored: Create again replays the first.
    await view.click('[data-draft="create"]');
    await settle();
    await settle();
    expect(api.creates).toHaveLength(3);
    expect(new Set(api.creates).size).toBe(1);
    expect(api.tasks).toHaveLength(1);
    expect(opened.created).toBe('TSK-1');
    await view.unmount();
  });
});

describe('a created task whose draft could not be removed', () => {
  it('keeps its operation id with the draft, so Create on the reopened draft replays it', async () => {
    const storage = store();
    const api = server(storage);
    const first = await openDraft(api, storage);
    await first.view.type('#panel-draft-name', 'Renew the domain');
    const removeItem = storage.removeItem.bind(storage);
    storage.removeItem = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    await first.view.click('[data-draft="create"]');
    await settle();
    expect(first.opened.created).toBe('TSK-1');
    await first.view.unmount();

    storage.removeItem = removeItem;
    const again = await openDraft(api, storage);
    await again.view.click('[data-draft="create"]');
    await settle();
    await settle();
    expect(new Set(api.creates).size).toBe(1);
    expect(api.tasks).toHaveLength(1);
    expect(again.opened.created).toBe('TSK-1');
    expect(storage.getItem(DRAFT_KEY)).toBeNull();
    await again.view.unmount();
  });
});

describe('a create whose operation id cannot reach storage', () => {
  it('is not sent, and the panel says why', async () => {
    const storage = store();
    const api = server(storage);
    const { view } = await openDraft(api, storage);
    await view.type('#panel-draft-name', 'Renew the domain');
    storage.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    await view.click('[data-draft="create"]');
    await settle();
    expect(api.creates).toHaveLength(0);
    expect(view.find('[data-draft-refusal]')?.textContent).toContain('could not be saved');
    expect(view.find('[data-draft="create"]')?.textContent).toBe('Create task');
    await view.unmount();
  });

  it('is in storage before the first request when storage works', async () => {
    const storage = store();
    const api = server(storage);
    const { view, opened } = await openDraft(api, storage);
    await view.type('#panel-draft-name', 'Renew the domain');
    await view.click('[data-draft="create"]');
    await settle();
    expect(api.keptAtSend).toEqual([api.creates[0]]);
    expect(opened.created).toBe('TSK-1');
    await view.unmount();
  });
});

describe('a former inline create left unresolved', () => {
  it('is offered as the draft held under its original operation id, and the old key goes', async () => {
    const storage = store();
    const id = '33333333-3333-4333-8333-000000000001';
    storage.setItem(
      FORMER_KEY,
      JSON.stringify({
        version: 1,
        owner: `${PERSON}:${String(sessionGeneration())}`,
        entries: {
          [id]: {
            origin: 'inline',
            operationId: id,
            editor: { id: '44444444-4444-4444-8444-000000000001', generation: 0 },
            body: { fields: { title: 'Call the printer' }, board: null },
            knowledge: { kind: 'unresolved' },
          },
        },
      }),
    );
    const api = server(storage);
    const { view, opened } = await openDraft(api, storage);
    expect(view.find('[data-draft="create"]')?.textContent).toBe('Retry Create');
    expect((view.find('#panel-draft-name') as HTMLInputElement).value).toBe('Call the printer');
    expect(storage.getItem(FORMER_KEY)).toBeNull();

    await view.click('[data-draft="create"]');
    await settle();
    expect(api.creates).toEqual([id]);
    expect(opened.created).toBe('TSK-1');
    await view.unmount();
  });
});
