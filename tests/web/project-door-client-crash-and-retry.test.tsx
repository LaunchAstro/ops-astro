// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A selected project's client on the Projects board's New task doors when a
// read crashes, is lost or answers an outage, and on its retry; across a
// business or person switch; on both doors; and at a Client filter address.

import { afterEach, describe, expect, it } from 'vitest';
import {
  CLIENT,
  OTHER,
  DENIED,
  EMPTY,
  ON_A,
  ON_B,
  answer,
  outage,
  lost,
  rejected,
  steeredApi,
  toolbarDoor,
  leaks,
  named,
  projectsPage,
  denyWithProjectHeld,
  settled,
} from './project-door-client-race-support.tsx';
import { tick } from './task-page-stub.tsx';
import { held } from './work-log-stand-in.tsx';

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('a board read that crashes, and its retry', () => {
  it('a board read that rejects names no client, and the board’s Retry brings the project’s client back', async () => {
    const page = await projectsPage();
    page.serve.board = rejected;
    const from = page.commits.length;
    await page.invalidate();
    expect(page.view.find('[data-outcome="unavailable"]')).not.toBeNull();
    expect(settled()).toEqual({ toolbar: undefined, toolbarName: undefined, empty: undefined });
    page.serve.board = answer(EMPTY);
    await page.retry();
    expect(leaks(page.commits.slice(from))).toEqual([]);
    expect(settled()).toEqual({ toolbar: CLIENT, toolbarName: 'Client A', empty: CLIENT });
  });

  it('a board read answered as an outage after a denial names no client until a live reread admits', async () => {
    const page = await projectsPage();
    await denyWithProjectHeld(page);
    const gate = held();
    page.serve.board = outage(gate);
    page.serve.project = answer(ON_B);
    const from = page.commits.length;
    await page.invalidate();
    gate.release(null);
    await tick();
    expect(page.view.find('[data-outcome="unavailable"]')).not.toBeNull();
    expect(settled()).toEqual({ toolbar: undefined, toolbarName: undefined, empty: undefined });
    page.serve.board = answer(EMPTY);
    await page.invalidate();
    expect(leaks(page.commits.slice(from))).toEqual([]);
    expect(named(page.commits, from).filter((one) => one === CLIENT)).toEqual([]);
    expect(settled()).toEqual({ toolbar: OTHER, toolbarName: 'Client B', empty: OTHER });
  });

  it('a board response lost after a denial names no client while it never answers', async () => {
    const page = await projectsPage();
    await denyWithProjectHeld(page);
    page.serve.board = lost;
    const from = page.commits.length;
    await page.panelChange();
    await page.invalidate();
    expect(page.view.find('[data-outcome="loading"]')).not.toBeNull();
    expect(leaks(page.commits.slice(from))).toEqual([]);
    expect(named(page.commits, from)).toEqual([]);
    page.serve.board = answer(EMPTY);
    page.serve.project = answer(ON_B);
    await page.invalidate();
    expect(settled()).toEqual({ toolbar: OTHER, toolbarName: 'Client B', empty: OTHER });
  });
});

describe('a project read that crashes, and its retry', () => {
  it('a project read that rejects at re-admission names no client until the live channel rereads it', async () => {
    const page = await projectsPage();
    await denyWithProjectHeld(page);
    page.serve.board = answer(EMPTY);
    page.serve.project = rejected;
    const from = page.commits.length;
    await page.panelChange();
    expect(page.view.find('[data-outcome="empty"]')).not.toBeNull();
    expect(settled()).toEqual({ toolbar: undefined, toolbarName: undefined, empty: undefined });
    page.serve.project = answer(ON_B);
    await page.invalidate();
    expect(named(page.commits, from).filter((one) => one === CLIENT)).toEqual([]);
    expect(settled()).toEqual({ toolbar: OTHER, toolbarName: 'Client B', empty: OTHER });
  });

  it('a project response lost at re-admission names no client while the board admits', async () => {
    const page = await projectsPage();
    await denyWithProjectHeld(page);
    page.serve.board = answer(EMPTY);
    page.serve.project = lost;
    const from = page.commits.length;
    await page.panelChange();
    await page.panelChange();
    expect(page.view.find('[data-outcome="empty"]')).not.toBeNull();
    expect(named(page.commits, from)).toEqual([]);
    page.serve.project = answer(ON_B);
    await page.invalidate();
    expect(settled()).toEqual({ toolbar: OTHER, toolbarName: 'Client B', empty: OTHER });
  });

  it('a project read answered as an outage names no client until a reread answers', async () => {
    const page = await projectsPage();
    const gate = held();
    page.serve.project = outage(gate);
    await page.invalidate();
    gate.release(null);
    await tick();
    expect(page.view.find('[data-outcome="empty"]')).not.toBeNull();
    expect(settled()).toEqual({ toolbar: undefined, toolbarName: undefined, empty: undefined });
    page.serve.project = answer(ON_B);
    const before = page.reads.project;
    // A task panel change while the board admits the reader rereads the project's client.
    await page.panelChange();
    expect(page.reads.project).toBe(before + 1);
    expect(settled()).toEqual({ toolbar: OTHER, toolbarName: 'Client B', empty: OTHER });
  });
});

describe('a business or person switch mid-flight', () => {
  it('the last reader’s project answer landing after the switch never reaches the new reader’s doors', async () => {
    const first = held();
    const page = await projectsPage(undefined, (api) => {
      api.serve.project = () => first.response;
    });
    expect(settled().toolbar).toBeUndefined();
    const beta = steeredApi('beta', 'Client B');
    beta.serve.project = answer(ON_B);
    const from = page.commits.length;
    await page.view.render(page.screen(0, 'beta:owner', beta.client));
    first.release(ON_A);
    await tick();
    await tick();
    expect(named(page.commits, from).filter((one) => one === CLIENT)).toEqual([]);
    expect(settled()).toEqual({ toolbar: OTHER, toolbarName: 'Client B', empty: OTHER });
  });

  it('the last reader’s board answer landing after the switch never restores its client', async () => {
    const page = await projectsPage();
    const board = held();
    page.serve.board = () => board.response;
    await page.invalidate();
    const beta = steeredApi('beta');
    beta.serve.board = lost;
    beta.serve.project = lost;
    const from = page.commits.length;
    await page.view.render(page.screen(0, 'beta:owner', beta.client));
    board.release(EMPTY);
    await tick();
    await tick();
    expect(named(page.commits, from)).toEqual([]);
    expect(settled()).toEqual({ toolbar: undefined, toolbarName: undefined, empty: undefined });
  });
});

describe('the toolbar door and the empty-board door', () => {
  it('the toolbar door names the client the empty-board door names, in every commit', async () => {
    const page = await projectsPage();
    const across = await denyWithProjectHeld(page);
    page.serve.board = answer(EMPTY);
    page.serve.project = answer(ON_B);
    await page.panelChange();
    across.release(ON_A);
    await tick();
    page.serve.project = answer(ON_A);
    await page.invalidate();
    const strays = page.commits.filter(
      (commit) => commit.board === 'empty' && commit.toolbar !== commit.empty,
    );
    expect(strays).toEqual([]);
    expect(settled()).toEqual({ toolbar: CLIENT, toolbarName: 'Client A', empty: CLIENT });
  });
});

describe('a Client filter address', () => {
  const address = `/projects/?f=${encodeURIComponent('client:"Client A"')}`;

  it('a client list answer landing after the board’s denial names no client', async () => {
    const page = await projectsPage(address);
    expect(toolbarDoor()?.dataset['newTaskClient']).toBe(CLIENT);
    const board = held();
    const clients = held();
    page.serve.board = () => board.response;
    page.serve.clients = () => clients.response;
    await page.invalidate();
    const from = page.commits.length;
    board.release(DENIED);
    await tick();
    clients.release({ ok: true, clients: [{ clientId: CLIENT, name: 'Client A' }] });
    await tick();
    await tick();
    expect(page.view.find('[data-outcome="denied"]')).not.toBeNull();
    expect(named(page.commits, from + 1)).toEqual([]);
    expect(toolbarDoor()?.dataset['newTaskClient']).toBeUndefined();
  });

  it('names the filter’s client again only once the board admits the reader', async () => {
    const page = await projectsPage(address);
    page.serve.board = answer(DENIED);
    await page.invalidate();
    expect(toolbarDoor()?.dataset['newTaskClient']).toBeUndefined();
    const board = held();
    page.serve.board = () => board.response;
    const from = page.commits.length;
    await page.panelChange();
    expect(named(page.commits, from)).toEqual([]);
    board.release(EMPTY);
    await tick();
    await tick();
    expect(toolbarDoor()?.dataset['newTaskClient']).toBe(CLIENT);
  });
});
