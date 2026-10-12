// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A selected project's client at a Client filter, under races: until its own read answers, no
// door names a client from any source. Every commit, and `doorContext` (what a click drafts).

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { doorContext } from '../../apps/web/src/screens/task/task-prefill.ts';
import { task, tick } from './task-page-stub.tsx';
import { held, pause } from './work-log-stand-in.tsx';
import {
  BOARD,
  CLIENT,
  DENIED,
  EMPTY,
  ON_A,
  ON_B,
  OTHER,
  answer,
  emptyDoor,
  leaks,
  named,
  outage,
  projectsPage,
  steeredApi,
  toolbarDoor,
  type Commit,
} from './project-door-client-race-support.tsx';

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

const AT_FILTER = `/projects/?board=${BOARD}&f=${encodeURIComponent('client:"Client A"')}`;
const AT_FILTER_AND_STAGE = `/projects/?board=${BOARD}&f=${encodeURIComponent(
  'client:"Client A",stage:"Enquiries"',
)}`;
/** A selected project whose board is scoped (a route), so a board reread does not admit until it answers. */
const AT_ROUTE_FILTER = `/projects/?board=${BOARD}&route=Agent&f=${encodeURIComponent('client:"Client A"')}`;
/** The project answers with no client the reader can name. */
const NO_CLIENT = { ok: true, task: task({ id: BOARD, client: null }), states: [] };

/** A held answer every read sent while it is out receives, each in its own response. */
const everyRead = (gate: ReturnType<typeof held>) => {
  const text = gate.response.then((response) => response.text());
  return () => text.then((body) => new Response(body, { status: 200 }));
};

/** What a click on each door copies into the draft: client id and name, or null for no door. */
const drafted = () =>
  [toolbarDoor(), emptyDoor()].map((door) => {
    if (door === null) return null;
    const { clientId, clientName } = doorContext(door);
    return { clientId, clientName };
  });
const toolbarDraft = () => drafted()[0];

/** Every commit from `from` in which a door named `client`. */
const naming = (commits: readonly Commit[], from: number, client: string) =>
  named(commits, from).filter((one) => one === client);

/** Commits from `from` in which the toolbar and empty-board doors named different clients. */
const disagreeing = (commits: readonly Commit[], from: number) =>
  commits
    .slice(from)
    .filter(
      (commit) =>
        commit.empty !== undefined &&
        commit.toolbar !== undefined &&
        commit.empty !== commit.toolbar,
    );

describe('a selected project at a Client filter while its client is reread', () => {
  it('a live change files neither the former client nor the filter’s until the project answers', async () => {
    const page = await projectsPage(AT_FILTER_AND_STAGE);
    expect(toolbarDraft()?.clientId).toBe(CLIENT);
    const refresh = held();
    page.serve.project = () => refresh.response;
    const from = page.commits.length;
    await page.invalidate();
    expect(naming(page.commits, from, CLIENT)).toEqual([]);
    expect(toolbarDraft()).toEqual({ clientId: null, clientName: undefined });
    refresh.release(ON_B);
    await tick();
    await tick();
    expect(toolbarDraft()).toEqual({ clientId: OTHER, clientName: 'Client B' });
    expect(disagreeing(page.commits, from)).toEqual([]);
  });

  it('a panel change names neither the former client nor the filter’s from the commit that reports it', async () => {
    const page = await projectsPage(AT_FILTER);
    expect(toolbarDraft()?.clientId).toBe(CLIENT);
    const refresh = held();
    // The open task panel moves the project to Client B and reports one change.
    page.serve.project = () => refresh.response;
    const from = page.commits.length;
    await page.panelChange();
    expect(page.reads.project).toBe(2);
    expect(naming(page.commits, from, CLIENT)).toEqual([]);
    refresh.release(ON_B);
    await tick();
    await tick();
    expect(toolbarDraft()).toEqual({ clientId: OTHER, clientName: 'Client B' });
  });
});

describe('a selected project at a Client filter across panel changes', () => {
  it('a second panel change while the board’s reread is out still rereads the project’s client', async () => {
    const page = await projectsPage(AT_FILTER);
    expect(toolbarDraft()?.clientId).toBe(CLIENT);
    const first = held();
    page.serve.board = () => first.response;
    // The first change rereads the project before the second moves it to Client B.
    await page.panelChange();
    expect(page.reads.project).toBe(2);
    page.serve.board = answer(EMPTY);
    page.serve.project = answer(ON_B);
    await page.panelChange();
    first.release(EMPTY);
    await tick();
    await tick();
    expect(page.view.find('[data-outcome="empty"]')).not.toBeNull();
    expect(
      toolbarDraft()?.clientId,
      'the board reread for the move, so the door follows it',
    ).not.toBe(CLIENT);
  });

  it('on a scoped board, a second panel change while the board’s reread is out still rereads the project’s client', async () => {
    const page = await projectsPage(AT_ROUTE_FILTER);
    expect(toolbarDraft()?.clientId).toBe(CLIENT);
    const first = held();
    page.serve.board = () => first.response;
    // The first change rereads the project before the second moves it to Client B.
    await page.panelChange();
    expect(page.reads.project).toBe(2);
    page.serve.board = answer(EMPTY);
    page.serve.project = answer(ON_B);
    await page.panelChange();
    first.release(EMPTY);
    await tick();
    await tick();
    expect(page.reads.board).toBe(3);
    expect(
      toolbarDraft()?.clientId,
      'the board reread for the move, so the door follows it',
    ).not.toBe(CLIENT);
  });
});

describe('a selected project at a Client filter on a floor tick or a late answer', () => {
  it('a rollup floor tick files neither client while the project reread is out', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const page = await projectsPage(AT_FILTER);
    expect(toolbarDraft()?.clientId).toBe(CLIENT);
    const refresh = held();
    page.serve.project = () => refresh.response;
    const from = page.commits.length;
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await pause();
    });
    await tick();
    expect(naming(page.commits, from, CLIENT)).toEqual([]);
    expect(toolbarDraft()?.clientId).toBeNull();
    refresh.release(ON_B);
    await tick();
    expect(toolbarDraft()).toEqual({ clientId: OTHER, clientName: 'Client B' });
  });

  it('two project rereads answering oldest-last settle on the newer client', async () => {
    const page = await projectsPage(AT_FILTER);
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
    expect(naming(page.commits, from, CLIENT)).toEqual([]);
    expect(toolbarDraft()).toEqual({ clientId: OTHER, clientName: 'Client B' });
  });
});

describe('a selected project at a Client filter whose own read fails or names no client', () => {
  it('a project that answers no client gives the filter’s client back once it settles', async () => {
    const page = await projectsPage(AT_FILTER);
    const refresh = held();
    page.serve.project = () => refresh.response;
    await page.invalidate();
    expect(toolbarDraft()?.clientId).toBeNull();
    refresh.release(NO_CLIENT);
    await tick();
    await tick();
    expect(toolbarDraft()).toEqual({ clientId: CLIENT, clientName: 'Client A' });
  });

  it('a refused project read names no client from the filter at any commit', async () => {
    const page = await projectsPage(AT_FILTER);
    const refusal = held();
    page.serve.project = () => refusal.response;
    await page.invalidate();
    const from = page.commits.length;
    refusal.release(DENIED);
    await tick();
    await tick();
    expect(page.commits.length).toBeGreaterThan(from);
    expect(named(page.commits, from)).toEqual([]);
    expect(toolbarDraft()).toEqual({ clientId: null, clientName: undefined });
  });

  it('a project read answered as an outage names no client until a live reread settles it', async () => {
    const page = await projectsPage(AT_FILTER);
    const gate = held();
    page.serve.project = outage(gate);
    const from = page.commits.length;
    await page.invalidate();
    gate.release(null);
    await tick();
    expect(toolbarDraft()?.clientId).toBeNull();
    page.serve.project = answer(ON_B);
    await page.invalidate();
    expect(naming(page.commits, from, CLIENT)).toEqual([]);
    expect(toolbarDraft()).toEqual({ clientId: OTHER, clientName: 'Client B' });
  });
});

describe('a selected project at a Client filter across a board’s answer', () => {
  it('the board’s Retry after an outage files no client until a fresh project read answers', async () => {
    const page = await projectsPage(AT_FILTER);
    const gate = held();
    page.serve.board = outage(gate);
    await page.invalidate();
    gate.release(null);
    await tick();
    expect(page.view.find('[data-outcome="unavailable"]')).not.toBeNull();
    const fresh = held();
    page.serve.board = answer(EMPTY);
    page.serve.project = () => fresh.response;
    const from = page.commits.length;
    await page.retry();
    expect(named(page.commits, from)).toEqual([]);
    fresh.release(ON_B);
    await tick();
    expect(toolbarDraft()).toEqual({ clientId: OTHER, clientName: 'Client B' });
  });
});

describe('a selected project at a Client filter across re-admission or a new reader', () => {
  it('re-admission after a denial files no client until a project read begun since answers', async () => {
    const page = await projectsPage(AT_FILTER);
    const across = held();
    page.serve.project = () => across.response;
    page.serve.board = answer(DENIED);
    await page.invalidate();
    const fresh = held();
    page.serve.board = answer(EMPTY);
    page.serve.project = everyRead(fresh);
    const from = page.commits.length;
    await page.invalidate();
    across.release(ON_A);
    await tick();
    expect(leaks(page.commits.slice(from))).toEqual([]);
    expect(named(page.commits, from)).toEqual([]);
    fresh.release(NO_CLIENT);
    await tick();
    await tick();
    expect(toolbarDraft()).toEqual({ clientId: CLIENT, clientName: 'Client A' });
  });

  it('a new reader files no client until their own project read answers, whatever their filter names', async () => {
    const page = await projectsPage(AT_FILTER);
    expect(toolbarDraft()?.clientId).toBe(CLIENT);
    const late = held();
    page.serve.project = () => late.response;
    await page.invalidate();
    const beta = steeredApi('beta');
    const own = held();
    beta.serve.clients = answer({ ok: true, clients: [{ clientId: OTHER, name: 'Client A' }] });
    beta.serve.project = () => own.response;
    const from = page.commits.length;
    await page.view.render(page.screen(0, 'beta:owner', beta.client));
    late.release(ON_A);
    await tick();
    await tick();
    expect(named(page.commits, from)).toEqual([]);
    own.release(NO_CLIENT);
    await tick();
    await tick();
    expect(naming(page.commits, from, CLIENT)).toEqual([]);
    expect(toolbarDraft()).toEqual({ clientId: OTHER, clientName: 'Client A' });
  });
});
