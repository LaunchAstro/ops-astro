// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C4 live-sync 4 (LIVE-SYNC.md, acceptance 4): B has an unsaved title edit
// when A renames the task. B's text is untouched, B sees that the task
// changed, and B's save meets `VERSION_STALE`: an edit begun at revision N is
// offered at N, and nothing is merged for B.

import { act } from 'react';
import { expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

const ID = '22222222-2222-4222-8222-222222222222';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** One task, a stream the case writes into, and an update checked against the revision. */
function server() {
  const task = {
    id: ID,
    key: 'TSK-2',
    title: 'As it began',
    description: null,
    state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
    assignee: null,
    due: null,
    priority: null,
    completedAt: null,
    revision: 1,
    history: [],
    comments: [],
  };
  const offered: number[] = [];
  const encoder = new TextEncoder();
  let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  const route = (at: string, body: string): Response => {
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.includes('/live?'))
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
      );
    if (at.endsWith('/task/read')) return json({ ok: true, task: { ...task } });
    if (at.endsWith('/task/update')) {
      const { expectedRevision } = JSON.parse(body) as { expectedRevision: number };
      offered.push(expectedRevision);
      return json(
        { refused: true, code: 'VERSION_STALE', names: [], fixes: ['Read the task again.'] },
        409,
      );
    }
    throw new Error(`unrouted ${at}`);
  };
  const fetch = ((url: string | URL, init?: RequestInit) =>
    Promise.resolve(route(String(url), String(init?.body)))) as unknown as typeof globalThis.fetch;
  const rename = (title: string): void => {
    task.title = title;
    task.revision += 1;
    stream?.enqueue(encoder.encode(`event: invalidate\ndata: task:${ID}\n\n`));
  };
  return { fetch, offered, rename };
}

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

async function until(say: string, check: () => boolean, deadline = Date.now() + 2000) {
  if (check()) return;
  if (Date.now() > deadline) throw new Error(`never happened: ${say}`);
  await act(async () => {
    await pause();
  });
  await until(say, check, deadline);
}

it('C4 live-sync 4: an unsaved edit is untouched, the change is shown, and its save meets VERSION_STALE', async () => {
  const api = server();
  const client = new OperationsClient({
    origin: '',
    businessKey: 'b',
    token: 't',
    fetch: api.fetch,
  });
  const page = await mount(<TaskDetailScreen client={client} grantKey="b:g" taskKey={ID} />);
  await until('the page', () => page.find('#task-title') !== null);
  const title = (): string => (page.find('#task-title') as HTMLInputElement).value;

  await page.type('#task-title', 'My unsaved title');
  expect(page.find('[data-live="changed"]')).toBeNull();
  api.rename('Somebody renamed it');
  await until('B sees that it changed', () => page.find('[data-live="changed"]') !== null);
  expect(title()).toBe('My unsaved title');

  await page.click('[data-draft-resolve="save"]');
  await until(
    'the save meets VERSION_STALE',
    () => page.find('[data-conflict="version"]') !== null,
  );
  expect(api.offered).toEqual([1]);
  expect(title()).toBe('My unsaved title');
  await page.unmount();
});
