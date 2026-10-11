// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// U112: every field chosen on the one kept draft goes through Create by its
// owning command, client first; a refused client or project stops Create
// before anything else is written; and the doors carry their page's scope.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { json, typeInto, unmountAll } from './perspective-support.tsx';
import { task as taskStub, tick } from './task-page-stub.tsx';
import { NEW_ID, NEW_KEY, create, draft, store, valueOf, type Sent } from './draft-support.tsx';
import { doorContext } from '../../apps/web/src/screens/task/task-prefill.ts';
import type { InternalTaskDetail } from '../../packages/core-wire/src/index.ts';
import { boardDoor } from '../../apps/web/src/screens/projects/ProjectsToolbar.tsx';
import { scopeOf, taskScope } from '../../apps/web/src/screens/task/panel-host.ts';
import { prefilledDraft } from '../../apps/web/src/screens/task/task-draft.ts';

afterEach(unmountAll);

const CLIENT = '11111111-1111-4111-8111-111111111111';
const BOARD = '22222222-2222-4222-8222-222222222222';

/** Answers every part with the task's next revision, the project list, and refuses `refuse`. */
function api(refuse: readonly string[] = []) {
  const sent: Sent[] = [];
  let revision = 1;
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const to = String(url).replace(/^.*?(\/[a-z]+\/[a-z_]+)$/u, '$1');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'];
    sent.push({ to, body });
    if (to === '/task/board')
      return Promise.resolve(
        json({ ok: true, tasks: [{ id: BOARD, title: 'Website rebuild' }], viewer: 'p', owed: 0 }),
      );
    if (refuse.includes(to))
      return Promise.resolve(
        json({ refused: true, code: 'FORBIDDEN', names: ['client'], fixes: [] }, 403),
      );
    if (to === '/task/create')
      return Promise.resolve(json({ recordId: NEW_ID, revision: 1, detail: { key: NEW_KEY } }));
    if (to === '/task/comment')
      return Promise.resolve(
        json({
          recordId: NEW_ID,
          revision: body['expectedRevision'],
          detail: { commentId: '88888888-8888-4888-8888-888888888888' },
        }),
      );
    revision += 1;
    return Promise.resolve(json({ recordId: NEW_ID, revision, detail: {} }));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { client, sent, writes: () => sent.filter((one) => one.to !== '/task/board') };
}

const SCOPE = { clientId: CLIENT, from: 'Client A' };

/** Focus the Project select, which reads the projects, then choose one. */
async function pickProject(view: Awaited<ReturnType<typeof draft>>['view']): Promise<void> {
  await act(() => {
    view.host.querySelector<HTMLSelectElement>('#panel-draft-board')?.focus();
  });
  await tick();
  await view.choose('#panel-draft-board', BOARD);
}

async function chooseAll(view: Awaited<ReturnType<typeof draft>>['view']): Promise<void> {
  await typeInto(view, '#panel-draft-name', 'Rebuild the booking page');
  await pickProject(view);
  await view.choose('#panel-draft-stage', 'enquiries');
  await view.choose('#panel-draft-priority', '2');
  await typeInto(view, '#panel-draft-description', 'The booking form drops mobile users.');
  await typeInto(view, '#panel-draft-brief', 'Check the form on a phone first.');
  await typeInto(view, '#panel-draft-note', 'From the kickoff call.');
}

describe('Core 04 1: the one draft carries every chosen field to Create', () => {
  it('project, stage, priority, description and agent brief survive a reopen and go out client first', async () => {
    const server = api();
    const storage = store();
    const first = await draft({ client: server.client, storage, scope: SCOPE });
    await chooseAll(first.view);
    await first.view.unmount();
    const again = await draft({ client: server.client, storage, scope: SCOPE });
    expect(valueOf(again.view, '#panel-draft-board')).toBe(BOARD);
    expect(valueOf(again.view, '#panel-draft-stage')).toBe('enquiries');
    expect(valueOf(again.view, '#panel-draft-priority')).toBe('2');
    expect(valueOf(again.view, '#panel-draft-brief')).toBe('Check the form on a phone first.');
    await create(again.view);
    expect(server.writes().map((one) => one.to)).toStrictEqual([
      '/task/create',
      '/task/set_party',
      '/task/move',
      '/task/set_stage',
      '/task/update',
      '/task/comment',
    ]);
    const [made, party, move, stage, update, note] = server.writes();
    expect(made?.body['fields']).toStrictEqual({ title: 'Rebuild the booking page' });
    expect(party?.body).toMatchObject({ recordId: NEW_ID, fields: { client: CLIENT } });
    expect(move?.body).toMatchObject({ recordId: NEW_ID, board: BOARD, expectedRevision: 2 });
    expect(stage?.body).toMatchObject({ fields: { stage: 'enquiries' }, expectedRevision: 3 });
    expect(update?.body).toMatchObject({
      fields: {
        description: 'The booking form drops mobile users.',
        agent_brief: 'Check the form on a phone first.',
        priority: 2,
      },
      expectedRevision: 4,
    });
    expect(note?.body).toMatchObject({ expectedRevision: 5 });
    expect(again.outcome.created).toBe(NEW_KEY);
    expect(storage.length).toBe(0);
  });

  it('a draft with no project chosen reads no task list before Create', async () => {
    const server = api();
    const { view } = await draft({ client: server.client });
    await typeInto(view, '#panel-draft-name', 'Quick one');
    await create(view);
    expect(server.sent.map((one) => one.to)).toStrictEqual(['/task/create']);
  });
});

describe('Core 04 4: client scope is set before any content part', () => {
  it.each([
    [
      '/task/set_party',
      'the client, the project, the stage, the description, the priority, the note',
    ],
    ['/task/move', 'the project, the stage, the description, the priority, the note'],
  ])(
    'a refused %s stops Create there, names what was not added, and makes one task',
    async (path, named) => {
      const server = api([path]);
      const { view, outcome } = await draft({ client: server.client, scope: SCOPE });
      await typeInto(view, '#panel-draft-name', 'Scoped work');
      await pickProject(view);
      await view.choose('#panel-draft-board', BOARD);
      await view.choose('#panel-draft-stage', 'sales');
      await view.choose('#panel-draft-priority', '1');
      await typeInto(view, '#panel-draft-description', 'Client words.');
      await typeInto(view, '#panel-draft-note', 'Client note.');
      await create(view);
      const sent = server.writes().map((one) => one.to);
      expect(sent.at(-1)).toBe(path);
      expect(sent.filter((to) => to === '/task/create')).toHaveLength(1);
      expect(sent).not.toContain('/task/update');
      expect(sent).not.toContain('/task/comment');
      expect(view.find('[data-draft-missed]')?.textContent).toBe(
        `Created ${NEW_KEY}; not added: ${named}. Add them on the task.`,
      );
      expect(outcome.created).toBeNull();
    },
  );
});

describe('Core 04 2: each door carries its page’s scope, never a fixed client', () => {
  it('the Projects board door carries the board’s client and project', () => {
    const door = document.createElement('button');
    for (const [name, value] of Object.entries(
      boardDoor(
        { kind: 'selected', boardId: BOARD, client: CLIENT, filters: [], focus: null },
        true,
      ),
    ))
      if (value !== undefined) door.setAttribute(name, value);
    const page = doorContext(door);
    expect(page).toMatchObject({ from: 'Projects', clientId: CLIENT, boardId: BOARD });
    expect(prefilledDraft(scopeOf(page).prefill!)).toMatchObject({
      clientId: CLIENT,
      boardId: BOARD,
      priority: null,
    });
  });

  it('an unscoped board door names no client and no project', () => {
    const door = document.createElement('button');
    for (const [name, value] of Object.entries(
      boardDoor({ kind: 'unboarded', filters: [], focus: null }, true),
    ))
      if (value !== undefined) door.setAttribute(name, value);
    expect(doorContext(door)).toMatchObject({ clientId: null });
    expect(doorContext(door)).not.toHaveProperty('boardId');
  });

  it('New task from a task carries its client, project, stage and priority', () => {
    const task = taskStub({
      client: CLIENT,
      stage: 'trust',
      priority: 3,
      board: { readable: true, id: BOARD, title: 'Website rebuild' },
    }) as unknown as InternalTaskDetail;
    const filed = prefilledDraft(taskScope(task).prefill!);
    expect(filed).toMatchObject({ clientId: CLIENT, boardId: BOARD, stage: 'trust', priority: 3 });
    expect(filed.why).toContain('priority P3 from the page');
  });

  it('a board the reader cannot open is not carried', () => {
    const task = taskStub({ board: { readable: false } }) as unknown as InternalTaskDetail;
    expect(taskScope(task).prefill?.boardId).toBeNull();
  });
});
