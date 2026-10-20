// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A new task from the plain board can be given a client. The draft fills in a
// category on its own, and that write is content (S0-5), so the task's client
// is locked from birth: the client has to be chosen on the draft, where Create
// sends it first, before anything that locks it.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { boardDoor } from '../../apps/web/src/screens/projects/ProjectsToolbar.tsx';
import { scopeOf } from '../../apps/web/src/screens/task/panel-host.ts';
import { doorContext, prefillOf } from '../../apps/web/src/screens/task/task-prefill.ts';
import { json, typeInto, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
import { NEW_ID, NEW_KEY, create, draft, valueOf, type Sent, type View } from './draft-support.tsx';

afterEach(unmountAll);

const RIVERBEND = '11111111-1111-4111-8111-111111111111';
const NORTHGATE = '33333333-3333-4333-8333-333333333333';
const AGENCY_PROJECT = '22222222-2222-4222-8222-222222222222';
const RIVERBEND_PROJECT = '44444444-4444-4444-8444-444444444444';

const CLIENTS = {
  ok: true,
  clients: [
    { clientId: RIVERBEND, name: 'Riverbend Bakery' },
    { clientId: NORTHGATE, name: 'Northgate Plumbing' },
  ],
};

const PROJECTS = {
  ok: true,
  tasks: [
    { id: AGENCY_PROJECT, title: 'Agency site', clientSet: false, client: null },
    {
      id: RIVERBEND_PROJECT,
      title: 'Bakery rebuild',
      clientSet: true,
      client: { clientId: RIVERBEND, name: 'Riverbend Bakery' },
    },
  ],
  viewer: 'p',
  owed: 0,
};

/** The business's clients and projects, and a receipt for every write; `late` holds the projects. */
function api(late = false) {
  const sent: Sent[] = [];
  let revision = 1;
  const held: (() => void)[] = [];
  const projects = (): Promise<Response> =>
    late
      ? new Promise((resolve) => {
          held.push(() => resolve(json(PROJECTS)));
        })
      : Promise.resolve(json(PROJECTS));
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const to = String(url).replace(/^.*?(\/[a-z]+\/[a-z_]+)$/u, '$1');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'];
    sent.push({ to, body });
    if (to === '/client/list') return Promise.resolve(json(CLIENTS));
    if (to === '/task/board') return projects();
    if (to === '/task/create')
      return Promise.resolve(json({ recordId: NEW_ID, revision: 1, detail: { key: NEW_KEY } }));
    revision += 1;
    return Promise.resolve(json({ recordId: NEW_ID, revision, detail: {} }));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return {
    client,
    sent,
    answerProjects: () => {
      for (const answer of held.splice(0)) answer();
    },
    writes: () => sent.filter((one) => !/\/list$|\/board$/u.test(one.to)),
  };
}

/** The draft as the plain board's New task opens it: the page's defaults, no client. */
function plainBoard() {
  const door = document.createElement('button');
  for (const [name, value] of Object.entries(boardDoor('/projects/?board=none', true)))
    if (value !== undefined) door.setAttribute(name, value);
  return scopeOf(doorContext(door));
}

/** Focus a select that reads its choices on first focus, then choose one. */
async function pick(view: View, selector: string, value: string): Promise<void> {
  await act(() => {
    view.host.querySelector<HTMLSelectElement>(selector)?.focus();
  });
  await tick();
  await view.choose(selector, value);
}

const optionsOf = (view: View, selector: string): readonly string[] =>
  [...(view.host.querySelector<HTMLSelectElement>(selector)?.options ?? [])].map(
    (option) => option.textContent ?? '',
  );

describe('a new task from the plain board can be given a client', () => {
  it('the draft offers the business’s clients and Create sends the chosen one before its defaults', async () => {
    const server = api();
    const { view, outcome } = await draft({ client: server.client, scope: plainBoard() });
    expect(valueOf(view, '#panel-draft-category')).toBe('admin');
    await typeInto(view, '#panel-draft-name', 'Draft the bakery newsletter');
    await pick(view, '#panel-draft-client', RIVERBEND);
    expect(optionsOf(view, '#panel-draft-client')).toStrictEqual([
      'No client',
      'Riverbend Bakery',
      'Northgate Plumbing',
    ]);
    await create(view);
    expect(server.writes().map((one) => one.to)).toStrictEqual([
      '/task/create',
      '/task/set_party',
      '/task/set_category',
    ]);
    expect(server.writes()[1]?.body).toMatchObject({
      recordId: NEW_ID,
      fields: { client: RIVERBEND },
      expectedRevision: 1,
    });
    expect(outcome.created).toBe(NEW_KEY);
  });

  it('a draft whose client is left alone reads no client list and sends no client', async () => {
    const server = api();
    const { view } = await draft({ client: server.client, scope: plainBoard() });
    await typeInto(view, '#panel-draft-name', 'Internal tidy-up');
    await create(view);
    expect(server.sent.map((one) => one.to)).toStrictEqual(['/task/create', '/task/set_category']);
  });

  it('choosing another client drops a project of a different client and keeps the agency’s own', async () => {
    const server = api();
    const { view } = await draft({ client: server.client, scope: plainBoard() });
    await pick(view, '#panel-draft-client', RIVERBEND);
    await pick(view, '#panel-draft-board', RIVERBEND_PROJECT);
    await view.choose('#panel-draft-client', NORTHGATE);
    expect(valueOf(view, '#panel-draft-board')).toBe('');
    await view.choose('#panel-draft-board', AGENCY_PROJECT);
    await view.choose('#panel-draft-client', RIVERBEND);
    expect(valueOf(view, '#panel-draft-board')).toBe(AGENCY_PROJECT);
  });
});

describe('a project list that answers after the client choice', () => {
  it('a project list that answers after the client is chosen says the project holds another client’s work', async () => {
    const server = api(true);
    const scope = {
      clientId: RIVERBEND,
      from: 'Bakery rebuild',
      prefill: prefillOf(
        {
          from: 'Bakery rebuild',
          clientId: RIVERBEND,
          clientName: 'Riverbend Bakery',
          boardId: RIVERBEND_PROJECT,
        },
        new Date('2026-10-13T00:00:00Z'),
      ),
    };
    const { view } = await draft({ client: server.client, scope });
    await pick(view, '#panel-draft-client', NORTHGATE);
    expect(valueOf(view, '#panel-draft-board')).toBe(RIVERBEND_PROJECT);
    expect(view.find('[data-draft-project-elsewhere]')).toBeNull();
    await act(async () => {
      server.answerProjects();
      await tick();
    });
    await tick();
    expect(optionsOf(view, '#panel-draft-board')).toContain('A project of another client');
    expect(view.find('[data-draft-project-elsewhere]')?.textContent).toBe(
      'This project holds another client’s work. Choose another project, or None, before Create.',
    );
  });
});
