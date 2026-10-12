// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// The Projects board's New task doors name a client only while the board
// admits the reader, at every commit and whatever names the client: the
// board's outage, a load after a denial and the project read's own refusal;
// the address's own `client=`; a project read still in flight after the
// project's client changed; and a Client filter's client that only a board
// row names, beside a populated client list.

import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { doorContext } from '../../apps/web/src/screens/task/task-prefill.ts';
import {
  BOARD,
  CLIENT,
  DENIED,
  EMPTY,
  ON_B,
  OTHER,
  answer,
  emptyDoor,
  leaks,
  named,
  projectsPage,
  settled,
  toolbarDoor,
} from './project-door-client-race-support.tsx';
import { task, tick } from './task-page-stub.tsx';
import { held, json } from './work-log-stand-in.tsx';

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

const unavailable = () => Promise.resolve(new Response('', { status: 503 }));
const NONE = { toolbar: undefined, toolbarName: undefined, empty: undefined };

describe('the door shares the board’s admission commit', () => {
  it('names no client in any commit of the board’s outage', async () => {
    const page = await projectsPage();
    expect(toolbarDoor()?.dataset['newTaskClient']).toBe(CLIENT);
    const from = page.commits.length;
    page.serve.board = unavailable;
    await page.invalidate();
    expect(page.view.find('[data-outcome="unavailable"]')).not.toBeNull();
    expect(leaks(page.commits.slice(from))).toEqual([]);
    expect(settled()).toEqual(NONE);
  });

  it('names no client in any commit of a load after a denial', async () => {
    const page = await projectsPage();
    page.serve.board = answer(DENIED);
    await page.invalidate();
    const from = page.commits.length;
    page.serve.board = () => held().response;
    await page.panelChange();
    expect(page.view.find('[data-outcome="loading"]')).not.toBeNull();
    expect(leaks(page.commits.slice(from))).toEqual([]);
    expect(settled()).toEqual(NONE);
  });

  it('names no client from the commit that draws the project read’s own refusal', async () => {
    const page = await projectsPage();
    const refusal = held();
    page.serve.project = () => refusal.response;
    await page.invalidate();
    const from = page.commits.length;
    refusal.release(DENIED);
    await tick();
    expect(page.commits.length).toBeGreaterThan(from);
    expect(named(page.commits, from)).toEqual([]);
    expect(settled()).toEqual(NONE);
  });
});

describe('the address’s own client consumes the board’s admission', () => {
  const address = `/projects/?board=${BOARD}&client=${CLIENT}`;

  it('a denied board’s door names not the address’s client', async () => {
    const page = await projectsPage(address);
    expect(toolbarDoor()?.dataset['newTaskClient']).toBe(CLIENT);
    const from = page.commits.length;
    page.serve.board = answer(DENIED);
    await page.invalidate();
    expect(page.view.find('[data-outcome="denied"]')).not.toBeNull();
    expect(leaks(page.commits.slice(from))).toEqual([]);
    expect(settled()).toEqual(NONE);
  });

  it('a door names the address’s client only once the board first admits the reader', async () => {
    const first = held();
    const page = await projectsPage(address, (api) => {
      api.serve.board = () => first.response;
    });
    expect(named(page.commits)).toEqual([]);
    first.release(EMPTY);
    await tick();
    await tick();
    expect(toolbarDoor()?.dataset['newTaskClient']).toBe(CLIENT);
  });
});

describe('a refresh after the project’s client changed', () => {
  it('a door clicked while the project read is out keeps no stale client in the draft', async () => {
    const page = await projectsPage();
    expect(toolbarDoor()?.dataset['newTaskClient']).toBe(CLIENT);
    const refresh = held();
    page.serve.project = () => refresh.response;
    await page.invalidate();
    expect(page.view.find('[data-outcome="denied"]')).toBeNull();
    expect(settled()).toEqual(NONE);
    expect(doorContext(toolbarDoor()!).clientId).toBeNull();
    expect(doorContext(emptyDoor()!).clientId).toBeNull();
    refresh.release(ON_B);
    await tick();
    expect(toolbarDoor()?.dataset['newTaskClient']).toBe(OTHER);
  });
});

describe('a Client filter’s client named only by a board row', () => {
  const CANARY = '77777777-7777-4777-8777-777777777777';
  const address = `/projects/?f=${encodeURIComponent('client:"Row canary"')}`;
  const ROWS = {
    ok: true,
    tasks: [
      {
        ...task({ clientSet: true, client: { clientId: CANARY, name: 'Row canary' } }),
        actualMinutes: 0,
        estimateMinutes: null,
        statePosition: null,
        waitReason: null,
        awaitingDecision: false,
        agent: null,
        myAgents: [],
        comments: { client: 0, mentions: 0, latest: null },
      },
    ],
  };
  const onRows = (api: { serve: { board: () => Promise<Response> } }) => {
    api.serve.board = answer(ROWS);
  };

  it('a board denial withdraws the row’s client beside a populated client list', async () => {
    const page = await projectsPage(address, onRows);
    expect(toolbarDoor()?.dataset['newTaskClient']).toBe(CANARY);
    const from = page.commits.length;
    page.serve.board = answer(DENIED);
    await page.invalidate();
    expect(page.view.find('[data-outcome="denied"]')).not.toBeNull();
    expect(named(page.commits, from)).toEqual([]);
  });

  it('a new reader’s first commit names neither the row’s client nor a listed one', async () => {
    const page = await projectsPage(address, onRows);
    expect(toolbarDoor()?.dataset['newTaskClient']).toBe(CANARY);
    const pending = new OperationsClient({
      origin: '',
      businessKey: 'beta',
      signedIn: true,
      fetch: (input) =>
        String(input).endsWith('/client/list')
          ? Promise.resolve(json({ ok: true, clients: [{ clientId: CLIENT, name: 'Client A' }] }))
          : new Promise<Response>(() => {}),
    });
    const from = page.commits.length;
    await page.view.render(page.screen(0, 'beta:owner', pending));
    expect(named(page.commits, from)).toEqual([]);
  });
});
