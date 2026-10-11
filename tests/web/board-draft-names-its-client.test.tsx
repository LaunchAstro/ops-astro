// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A new task filed from a client's board opens a draft filled in with that
// client, and its one sentence names the client among what was guessed. The
// client may come from the board's scope (a Clients row door) or from the
// Client filter chosen on the board. The doors carry the filters the board
// shows now, not the ones it was opened with, in a panel too.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { doorContext, prefillOf } from '../../apps/web/src/screens/task/task-prefill.ts';
import { facetId } from '../../packages/ui/src/board/project-facets.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { SUMMIT_TASK, clientFor } from './projects-board-destination-support.tsx';
import { json, tick } from './work-log-stand-in.tsx';
import { OrderedCreateServer, closeAll, draftTab, file, open } from './p05-draft-create-support.ts';
import { unmountAll } from './perspective-support.tsx';

afterEach(closeAll);
afterEach(unmountAll);

const NORTH = { clientId: '11111111-1111-4111-8111-111111111111', name: 'Example Client North' };
const NOW = new Date('2026-10-06T22:00:00Z');
const ROW = {
  ...SUMMIT_TASK,
  title: 'Draft the spring newsletter',
  stage: 'enquiries',
  client: NORTH,
};

/** The board with one row of North's, in the Enquiries stage; `client.list` names North. */
const fetch = ((url: string | URL): Promise<Response> => {
  const at = String(url);
  if (at.endsWith('/task/board'))
    return Promise.resolve(json({ ok: true, tasks: [ROW], changedAt: null, viewer: null }));
  if (at.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
  if (at.endsWith('/client/list')) return Promise.resolve(json({ ok: true, clients: [NORTH] }));
  return new Promise<Response>(() => {});
}) as unknown as typeof globalThis.fetch;

async function board(address: string, inPanel: boolean): Promise<Mounted> {
  const client = clientFor(fetch);
  const view = await mount(
    <Projects
      client={client}
      grantKey="alpha:owner"
      navigate={() => {}}
      address={address}
      inPanel={inPanel}
      canFileTask
    />,
  );
  await tick();
  await tick();
  return view;
}

/** What the toolbar's New task would file the draft with. */
function toolbarDoor(view: Mounted) {
  const door = view.find('[data-projects-new-task]');
  expect(door, 'the board draws its New task').toBeInstanceOf(HTMLElement);
  return doorContext(door as HTMLElement);
}

/** Press one filter in the board's own filter menu. */
async function press(view: Mounted, id: string): Promise<void> {
  if (view.find(`[data-add='${id}']`) === null) await view.click('.cbd__funnel');
  const facet = view.find(`[data-add='${id}']`);
  expect(facet, `the filter menu offers ${id}`).not.toBeNull();
  await act(() => {
    facet!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await tick();
}

describe('a draft filed from a client’s board says which client it guessed', () => {
  it('the sentence names the client when the page names nothing else', () => {
    const prefill = prefillOf(
      { from: 'Projects', clientId: NORTH.clientId, clientName: NORTH.name },
      NOW,
    );
    expect(prefill.clientId).toBe(NORTH.clientId);
    expect(prefill.why).toBe(
      'Guessed from the page: client Example Client North, due in 7 days, and the category fell back to Admin; no owner guessed.',
    );
  });

  it('the sentence names the client beside the other guesses', () => {
    const prefill = prefillOf(
      { from: 'Inbox', subject: 'Checkout down', clientId: NORTH.clientId, clientName: NORTH.name },
      NOW,
    );
    expect(prefill.why).toBe(
      'Guessed from “Checkout down”: client Example Client North, due in 7 days, and the category fell back to Admin; no owner guessed.',
    );
  });

  it('the toolbar door on a client-scoped board carries the client’s id and name', async () => {
    const view = await board(`/projects/?pool=aggregate&client=${NORTH.clientId}`, false);
    const page = toolbarDoor(view);
    expect(page).toMatchObject({ clientId: NORTH.clientId, clientName: NORTH.name });
    expect(prefillOf(page, NOW).why).toContain('client Example Client North');
    await view.unmount();
  });

  it('in the App, the draft from a client-scoped board names the client in its sentence', async () => {
    const server = new OrderedCreateServer();
    const served = server.fetch;
    server.fetch = (url, init) =>
      String(url).endsWith('/client/list')
        ? Promise.resolve(json({ ok: true, clients: [NORTH] }))
        : served(url, init);
    const app = await open(
      server,
      draftTab(),
      `/projects/?pool=aggregate&client=${NORTH.clientId}`,
    );
    await file(app);
    expect(app.view.find('[data-draft-admission]')?.textContent).toContain(
      'client Example Client North',
    );
  });
});

describe('the board’s doors carry the filters the board shows now', () => {
  for (const inPanel of [false, true]) {
    const where = inPanel ? 'in a panel' : 'on the page';
    it(`a Client filter chosen on the board fills the door with that client, ${where}`, async () => {
      const view = await board('/projects/?board=none&f=', inPanel);
      expect(toolbarDoor(view)).toMatchObject({ clientId: null });
      await press(view, facetId('Client', NORTH.name));
      expect(toolbarDoor(view)).toMatchObject({ clientId: NORTH.clientId, clientName: NORTH.name });
      await view.unmount();
    });

    it(`a stage chosen on the board fills the door with that stage, ${where}`, async () => {
      const view = await board('/projects/?board=none&f=', inPanel);
      expect(toolbarDoor(view)).not.toHaveProperty('stage');
      await press(view, facetId('Stage', 'Enquiries'));
      expect(toolbarDoor(view)).toMatchObject({ stage: 'enquiries' });
      await view.unmount();
    });
  }
});
