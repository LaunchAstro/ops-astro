// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A tick is spent for the row's revision, not for the row: once a landed tick
// is followed by a reread that draws the same to-do at a new revision (it was
// reopened elsewhere), ticking it again sends task.complete at that revision.

import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { json, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
import { TODOS, todos, type Sent } from './todos-support.tsx';

afterEach(unmountAll);

it('a to-do drawn again at a new revision after its tick landed can be ticked again', async () => {
  const sent: Sent[] = [];
  let revision = 3;
  const reply = (url: string | URL, init?: RequestInit): Response => {
    const at = String(url);
    if (at.endsWith('/live?topic=board'))
      return new Response(new ReadableStream(), {
        headers: { 'content-type': 'text/event-stream' },
      });
    const to = at.replace(/^.*?(\/[a-z]+\/[a-z_]+)$/u, '$1');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'];
    sent.push({ to, body });
    if (to === '/task/todos') return json({ ok: true, todos: [{ ...TODOS[0], revision }] });
    if (to === '/person/list') return json({ ok: true, persons: [] });
    if (to === '/client/list') return json({ ok: true, clients: [] });
    if (to === '/preference/read') return json({ preferences: {} });
    // The tick lands, and the to-do is reopened elsewhere, two revisions on.
    revision += 2;
    return json({ recordId: body['recordId'], revision });
  };
  const fetch = ((url: string | URL, init?: RequestInit) =>
    Promise.resolve(reply(url, init))) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const { view } = await todos({ client });
  const completes = () => sent.filter((one) => one.to === '/task/complete');
  await view.click('[data-todo-row="Proj-Alpha"] [data-todo-tick]');
  await tick();
  await tick();
  expect(completes()).toHaveLength(1);
  expect(sent.filter((one) => one.to === '/task/todos').length).toBeGreaterThan(1);
  await view.click('[data-todo-row="Proj-Alpha"] [data-todo-tick]');
  await tick();
  await tick();
  expect(completes()).toHaveLength(2);
  expect(completes()[1]?.body).toMatchObject({ recordId: 'id-Proj-Alpha', expectedRevision: 5 });
});
