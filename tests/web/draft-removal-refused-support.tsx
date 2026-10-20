// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared by the suites on a held Create whose draft the browser will not
// remove or rewrite: a server that keeps one answer per operation id, a
// refusal included, as the register does; the draft mounted, and the gestures
// they share.
//
// A harness, not a suite: nothing here runs on its own.

import { act } from 'react';
import { expect } from 'vitest';
import { DraftPanel } from '../../apps/web/src/screens/task/DraftPanel.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { settle, type Mounted, mount } from '../surfaces/mount.tsx';
import { store } from './draft-support.tsx';

export const PERSON = 'alpha:mia@alpha.local';
export const DRAFT_KEY = `ops-astro.task-draft.${PERSON}`;
export const FIRST_ID = '22222222-2222-4222-8222-000000000001';

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const REFUSED = { refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] };

/** What the next create meets; `hold` keeps each answer back until a test releases it. */
export interface Next {
  unreachable: boolean;
  lose: boolean;
  refuse: boolean;
  hold: boolean;
}

export function server() {
  const tasks: string[] = [];
  const creates: string[] = [];
  const refused = new Set<string>();
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
    if (next.refuse && !tasks.includes(id)) refused.add(id);
    next.refuse = false;
    if (refused.has(id)) {
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

export type Api = ReturnType<typeof server>;

/** One host's hold: a remount under it finds the Create still out. */
export const sameHost = (): (() => boolean) => () => true;

export async function openDraft(
  api: Api,
  storage: Storage,
  hold: () => () => boolean = () => () => true,
) {
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
export const refuseRemoval = (storage: Storage): void => {
  storage.removeItem = () => {
    throw new DOMException('denied', 'SecurityError');
  };
};

/** A duplicated tab starts with a copy of this tab's storage. */
export function duplicate(from: Storage): Storage {
  const copy = store();
  for (let index = 0; index < from.length; index += 1) {
    const key = from.key(index);
    if (key !== null) copy.setItem(key, from.getItem(key) ?? '');
  }
  return copy;
}

/** The create id kept with the draft in `storage`, or null. */
export const heldId = (storage: Storage): string | null =>
  (JSON.parse(storage.getItem(DRAFT_KEY) ?? '{}') as { attempt?: { id?: string } }).attempt?.id ??
  null;

export const createLabel = (view: Mounted): string | null | undefined =>
  view.find('[data-draft="create"]')?.textContent;

export const pressCreate = async (view: Mounted): Promise<void> => {
  await view.click('[data-draft="create"]');
  await settle();
  await settle();
};

/** Answers the held create at `index`, then lets the panel draw it. */
export const release = async (api: Api, index: number): Promise<void> => {
  await act(async () => {
    api.held[index]?.();
    await Promise.resolve();
  });
  await settle();
  await settle();
};

/** A Create the server stored whose answer was lost: the draft is left holding its id. */
export async function storedAnswerLost(api: Api, storage: Storage): Promise<void> {
  const first = await openDraft(api, storage);
  await first.view.type('#panel-draft-name', 'Renew the domain');
  api.next.lose = true;
  await pressCreate(first.view);
  await first.view.unmount();
}

export async function reopenAndRetry(api: Api, storage: Storage): Promise<string | null> {
  const again = await openDraft(api, storage);
  expect(createLabel(again.view)).toBe('Retry Create');
  await pressCreate(again.view);
  await again.view.unmount();
  return again.opened.created;
}
