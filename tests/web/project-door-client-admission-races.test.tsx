// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// Races against the admission rules for the Projects board's New task doors:
// the address's own `client=` under a denial, an outage, a load after a
// denial, a reader switch and a Client filter; and the refresh window (a live
// change, a task panel change, the rollup floor, the board's Retry) in which a
// click copies the door's client into a draft through `doorContext`.

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { doorContext } from '../../apps/web/src/screens/task/task-prefill.ts';
import {
  BOARD,
  CLIENT,
  DENIED,
  EMPTY,
  ON_A,
  ON_B,
  OTHER,
  answer,
  leaks,
  named,
  outage,
  projectsPage,
  settled,
  steeredApi,
  toolbarDoor,
  type Commit,
} from './project-door-client-race-support.tsx';
import { tick } from './task-page-stub.tsx';
import { held, pause } from './work-log-stand-in.tsx';

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

const NONE = { toolbar: undefined, toolbarName: undefined, empty: undefined };
const LIST_A = { ok: true, clients: [{ clientId: CLIENT, name: 'Client A' }] };
const LIST_B = { ok: true, clients: [{ clientId: OTHER, name: 'Client B' }] };
const AT_CLIENT = `/projects/?board=${BOARD}&client=${CLIENT}`;

/** What a click on the toolbar door copies into the draft. */
const drafted = () => {
  const door = toolbarDoor();
  if (door === null) return null;
  const { clientId, clientName } = doorContext(door);
  return { clientId, clientName };
};

/** Commits in which a door named `client` while the board was not settled on an answer. */
const unsettledNaming = (commits: readonly Commit[], from: number, client: string) =>
  commits
    .slice(from)
    .filter(
      (commit) =>
        commit.board !== 'ready' &&
        commit.board !== 'empty' &&
        (commit.toolbar === client || commit.empty === client),
    );

describe('the address’s own client under a race', () => {
  it('a client list answer landing after the board’s denial names not the address’s client', async () => {
    const page = await projectsPage(AT_CLIENT);
    expect(drafted()?.clientId).toBe(CLIENT);
    const board = held();
    const list = held();
    page.serve.board = () => board.response;
    page.serve.clients = () => list.response;
    await page.panelChange();
    const from = page.commits.length;
    board.release(DENIED);
    await tick();
    list.release(LIST_A);
    await tick();
    await tick();
    expect(page.view.find('[data-outcome="denied"]')).not.toBeNull();
    expect(named(page.commits, from)).toEqual([]);
    expect(drafted()).toEqual({ clientId: null, clientName: undefined });
  });

  it('a re-admitted board names the address’s client only once its client list answers', async () => {
    const page = await projectsPage(AT_CLIENT);
    page.serve.board = answer(DENIED);
    await page.invalidate();
    const list = held();
    page.serve.board = answer(EMPTY);
    page.serve.clients = () => list.response;
    const from = page.commits.length;
    await page.panelChange();
    expect(named(page.commits, from)).toEqual([]);
    expect(drafted()?.clientId).toBeNull();
    list.release(LIST_A);
    await tick();
    await tick();
    expect(drafted()).toEqual({ clientId: CLIENT, clientName: 'Client A' });
  });
});

describe('the address’s own client through an outage or a load', () => {
  it('names not the address’s client through an outage, and the board’s Retry restores it', async () => {
    const page = await projectsPage(AT_CLIENT);
    const gate = held();
    page.serve.board = outage(gate);
    const from = page.commits.length;
    await page.invalidate();
    gate.release(null);
    await tick();
    expect(page.view.find('[data-outcome="unavailable"]')).not.toBeNull();
    expect(drafted()?.clientId).toBeNull();
    page.serve.board = answer(EMPTY);
    await page.retry();
    expect(leaks(page.commits.slice(from))).toEqual([]);
    expect(unsettledNaming(page.commits, from, CLIENT)).toEqual([]);
    expect(drafted()).toEqual({ clientId: CLIENT, clientName: 'Client A' });
  });

  it('names not the address’s client in any commit of a load after a denial', async () => {
    const page = await projectsPage(AT_CLIENT);
    page.serve.board = answer(DENIED);
    await page.invalidate();
    const from = page.commits.length;
    const board = held();
    page.serve.board = () => board.response;
    await page.panelChange();
    await page.invalidate();
    expect(page.view.find('[data-outcome="loading"]')).not.toBeNull();
    expect(named(page.commits, from)).toEqual([]);
    board.release(DENIED);
    await tick();
    expect(named(page.commits, from)).toEqual([]);
  });
});

describe('the address’s own client across a reader switch', () => {
  it('a new reader who does not reach the address’s client never names it', async () => {
    const page = await projectsPage(AT_CLIENT);
    expect(drafted()?.clientId).toBe(CLIENT);
    const late = held();
    page.serve.clients = () => late.response;
    await page.invalidate();
    const beta = steeredApi('beta');
    beta.serve.clients = answer(LIST_B);
    const from = page.commits.length;
    await page.view.render(page.screen(0, 'beta:owner', beta.client));
    late.release(LIST_A);
    await tick();
    await tick();
    expect(named(page.commits, from)).toEqual([]);
    expect(settled()).toEqual(NONE);
  });

  it('a new reader’s held client list names no client until it answers for them', async () => {
    const page = await projectsPage(AT_CLIENT);
    const list = held();
    const beta = steeredApi('beta');
    beta.serve.clients = () => list.response;
    const from = page.commits.length;
    await page.view.render(page.screen(0, 'beta:owner', beta.client));
    await tick();
    expect(named(page.commits, from)).toEqual([]);
    list.release(LIST_A);
    await tick();
    await tick();
    expect(drafted()).toEqual({ clientId: CLIENT, clientName: 'Client A' });
  });

  it('a new reader’s Client filter names only the client their own list gives that name', async () => {
    const address = `/projects/?f=${encodeURIComponent('client:"Client A"')}`;
    const page = await projectsPage(address);
    expect(drafted()?.clientId).toBe(CLIENT);
    const beta = steeredApi('beta');
    beta.serve.clients = answer({ ok: true, clients: [{ clientId: OTHER, name: 'Client A' }] });
    const from = page.commits.length;
    await page.view.render(page.screen(0, 'beta:owner', beta.client));
    await tick();
    await tick();
    expect(named(page.commits, from).filter((one) => one === CLIENT)).toEqual([]);
    expect(drafted()).toEqual({ clientId: OTHER, clientName: 'Client A' });
  });
});

describe('the refresh window, where a click copies the door’s client', () => {
  it('two project rereads answering oldest-last leave the newer client on the door', async () => {
    const page = await projectsPage();
    const older = held();
    const newer = held();
    page.serve.project = () => older.response;
    await page.invalidate();
    page.serve.project = () => newer.response;
    await page.invalidate();
    const from = page.commits.length;
    newer.release(ON_B);
    await tick();
    older.release(ON_A);
    await tick();
    await tick();
    expect(drafted()).toEqual({ clientId: OTHER, clientName: 'Client B' });
    const since = page.commits.findIndex((commit, at) => at >= from && commit.toolbar === OTHER);
    expect(named(page.commits, since).filter((one) => one === CLIENT)).toEqual([]);
  });

  it('a task panel change that rereads the board files no client the project has left', async () => {
    const page = await projectsPage();
    expect(drafted()?.clientId).toBe(CLIENT);
    // The project is moved from Client A to Client B in the open task panel.
    page.serve.project = answer(ON_B);
    await page.panelChange();
    expect(page.reads.board).toBe(2);
    expect(drafted()?.clientId).not.toBe(CLIENT);
  });
});

describe('the refresh window on a floor tick or a Retry', () => {
  it('a rollup floor tick names no client while the project reread is out', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const page = await projectsPage();
    expect(drafted()?.clientId).toBe(CLIENT);
    const refresh = held();
    page.serve.project = () => refresh.response;
    const before = page.reads.project;
    const from = page.commits.length;
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await pause();
    });
    await tick();
    expect(page.reads.project).toBe(before + 1);
    expect(named(page.commits, from + 1).filter((one) => one === CLIENT)).toEqual([]);
    expect(drafted()?.clientId).toBeNull();
    refresh.release(ON_B);
    await tick();
    expect(drafted()).toEqual({ clientId: OTHER, clientName: 'Client B' });
  });

  it('the board’s Retry after an outage files no client until a fresh project read answers', async () => {
    const page = await projectsPage();
    const gate = held();
    page.serve.board = outage(gate);
    await page.invalidate();
    gate.release(null);
    await tick();
    const fresh = held();
    page.serve.board = answer(EMPTY);
    page.serve.project = () => fresh.response;
    const before = page.reads.project;
    const from = page.commits.length;
    await page.retry();
    expect(page.reads.project).toBe(before + 1);
    expect(named(page.commits, from)).toEqual([]);
    expect(drafted()?.clientId).toBeNull();
    fresh.release(ON_B);
    await tick();
    expect(drafted()).toEqual({ clientId: OTHER, clientName: 'Client B' });
  });
});

describe('a first board denial no render drew', () => {
  it('a first board denial and a floor reread drawn in one render withdraw the project read begun at mount', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const denial = held();
    const across = held();
    const page = await projectsPage(undefined, (api) => {
      api.serve.board = () => denial.response;
      api.serve.project = () => across.response;
    });
    const readmit = held();
    page.serve.board = () => readmit.response;
    page.serve.project = answer(ON_B);
    const before = page.reads.project;
    // The first board answer is a denial, and the floor rereads the board before React draws it.
    await act(async () => {
      denial.release(DENIED);
      await pause();
      vi.advanceTimersByTime(30_000);
      await pause();
    });
    await tick();
    const from = page.commits.length;
    across.release(ON_A);
    await tick();
    readmit.release(EMPTY);
    await tick();
    await tick();
    expect(page.commits.slice(from).map((commit) => commit.board)).toContain('empty');
    expect(named(page.commits, from).filter((one) => one === CLIENT)).toEqual([]);
    expect(page.reads.project).toBe(before + 1);
    expect(drafted()).toEqual({ clientId: OTHER, clientName: 'Client B' });
  });
});
