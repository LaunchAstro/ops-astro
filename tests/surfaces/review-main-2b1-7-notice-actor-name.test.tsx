// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-MAIN-2B1-7, red proof: "Changed since you started editing by ..."
// never names anyone.
//
// changedSince (apps/web/src/screens/task/Notices.tsx) looks each new history
// entry's `actorId` up in `namesOf` (apps/web/src/screens/TaskDetail.tsx), a
// map keyed by personId from person.list. A history entry's `actorId` is
// audit_events.actor_id (packages/core-commands/src/reads/tasks.ts), an
// actors.id, and an actor has its own random id, not its person's
// (scripts/local-seed.mjs). So every lookup misses and the notice says
// "someone". c4-live-sync-4 passes only because its fixture uses one string
// for both ids. Here Ana Bell is person 'p-ana' acting as actor 'a-ana'.
//
// What the read exposes today: HistoryEntry (packages/core-wire/src/views.ts)
// is { at, actorId, operation } and PersonView is { personId, name }, so
// nothing on the wire ties an actor to a person and the web cannot fix this
// alone. A fix needs the history projection to carry the actor's person (join
// public.actors on actor_id and return actors.person_id, null for a non-person
// actor) and changedSince to name by that person id. This fixture already
// sends that as `personId` on each history entry, so the test passes once the
// fix exposes it under that name; if the fix names the field otherwise, rename
// it here. (Person.list exposing each person's actor id would also work, and
// would need the PEOPLE fixture changed to match.)

import { act } from 'react';
import { expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

const ID = '22222222-2222-4222-8222-222222222222';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The people this reader can list: not whoever made the last change unseen. */
const PEOPLE = [
  { personId: 'p-ana', name: 'Ana Bell' },
  { personId: 'p-bo', name: 'Bo Reyes' },
];

/** One task, a stream the case writes into, and an update checked against the revision. */
// oxlint-disable-next-line max-lines-per-function -- the stand-in API is one table of routes
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
    history: [
      { at: '2026-09-29T09:00:00Z', actorId: 'a-bo', personId: 'p-bo', operation: 'task.create' },
    ] as Record<string, unknown>[],
    comments: [] as Record<string, unknown>[],
  };
  const offered: number[] = [];
  const encoder = new TextEncoder();
  let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  const route = (at: string, body: string): Response => {
    if (at.endsWith('/person/list')) return json({ ok: true, persons: PEOPLE });
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
  // A read takes a tick, as over a network, so the page's loading state is drawn.
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/task/read')) await pause();
    return route(String(url), String(init?.body));
  }) as unknown as typeof globalThis.fetch;
  const invalidate = (): void => {
    task.revision += 1;
    stream?.enqueue(encoder.encode(`event: invalidate\ndata: task:${ID}\n\n`));
  };
  return { fetch, offered, task, invalidate };
}

/** Ana moves the task on and says so, recorded as the server would. */
function moveOn(api: ReturnType<typeof server>): void {
  const { task } = api;
  task.state = { id: 's2', key: 'done', label: 'Done', machineCategory: 'completed' };
  task.comments.push({
    id: 'c-ana',
    audience: 'internal',
    comment_type: 'note',
    author: 'Ana Bell',
    posted_at: '2026-09-30T01:00:00Z',
    body: 'Moved it on',
  });
  task.history.push(
    // Ana Bell is person p-ana; her actor, which the audit records, is a-ana.
    { at: '2026-09-30T01:00:00Z', actorId: 'a-ana', personId: 'p-ana', operation: 'task.move' },
    // Someone this reader cannot list: named as nobody in particular.
    {
      at: '2026-09-30T01:00:01Z',
      actorId: 'a-unlisted',
      personId: 'p-unlisted',
      operation: 'task.comment',
    },
  );
  api.invalidate();
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

it('REVIEW-MAIN-2B1-7: the changed-since notice names the person behind a history actor id (actor a-ana is Ana Bell, person p-ana)', async () => {
  const api = server();
  const client = new OperationsClient({
    origin: '',
    businessKey: 'b',
    signedIn: true,
    fetch: api.fetch,
  });
  const page = await mount(<TaskDetailScreen client={client} grantKey="b:g" taskKey={ID} />);
  await until('the page', () => page.find('#task-title') !== null);

  await page.type('#task-title', 'My unsaved title');
  moveOn(api);
  await until(
    'the comment arrives under the draft',
    () => page.find('[data-comment-id="c-ana"]') !== null,
  );
  expect(page.find('[data-live-what]')?.textContent).toBe('status, a comment');
  expect(
    page.find('[data-live-who]')?.textContent,
    'the notice names Ana Bell, whose actor id differs from her person id',
  ).toBe('Ana Bell, someone');
  await page.unmount();
});
