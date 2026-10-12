// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A selected project's client on the Projects board's New task doors, against
// reads answering in the hostile order: the board's denial at each commit, two
// reads in flight, and a project answer minted before a denial landing after
// re-admission. No door names a client while the board does not admit the reader.

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT,
  OTHER,
  DENIED,
  EMPTY,
  ON_A,
  ON_B,
  answer,
  outage,
  toolbarDoor,
  leaks,
  named,
  projectsPage,
  denyWithProjectHeld,
  settled,
} from './project-door-client-race-support.tsx';
import { tick } from './task-page-stub.tsx';
import { held, pause } from './work-log-stand-in.tsx';

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

describe('the board’s denial and the doors at each commit', () => {
  it('the toolbar door names no client in the commit that draws the board’s denial', async () => {
    const page = await projectsPage();
    expect(toolbarDoor()?.dataset['newTaskClient']).toBe(CLIENT);
    const board = held();
    page.serve.board = () => board.response;
    await page.invalidate();
    const from = page.commits.length;
    board.release(DENIED);
    await tick();
    expect(page.view.find('[data-outcome="denied"]')).not.toBeNull();
    expect(leaks(page.commits.slice(from))).toEqual([]);
  });

  it('a denial and a floor reread drawn in one render still withdraw the answer read across the denial', async () => {
    // The tab's rollup floor ticks on its own interval; nothing else here is faked.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const page = await projectsPage();
    const across = held();
    const denial = held();
    const readmit = held();
    page.serve.project = () => across.response;
    page.serve.board = () => denial.response;
    await page.invalidate();
    page.serve.project = answer(ON_B);
    page.serve.board = () => readmit.response;
    const before = page.reads.project;
    // The board's denial lands, and the floor rereads the board before React draws the denial.
    await act(async () => {
      denial.release(DENIED);
      await pause();
      vi.advanceTimersByTime(30_000);
      await pause();
    });
    await tick();
    const from = page.commits.length;
    // The project answer minted before the denial lands while the board is still out.
    across.release(ON_A);
    await tick();
    readmit.release(EMPTY);
    await tick();
    await tick();
    expect(page.commits.slice(from).map((commit) => commit.board)).toContain('empty');
    expect(named(page.commits, from).filter((one) => one === CLIENT)).toEqual([]);
    expect(page.reads.project).toBe(before + 1);
    expect(toolbarDoor()?.dataset['newTaskClient']).toBe(OTHER);
  });
});

describe('two board reads in flight answering in the hostile order', () => {
  it('an older board read admitting after a newer one denied restores no client', async () => {
    const page = await projectsPage();
    const older = held();
    const newer = held();
    page.serve.board = () => older.response;
    await page.invalidate();
    page.serve.board = () => newer.response;
    await page.invalidate();
    expect(page.reads.board).toBe(3);
    const from = page.commits.length;
    newer.release(DENIED);
    await tick();
    older.release(EMPTY);
    await tick();
    await tick();
    expect(page.view.find('[data-outcome="denied"]')).not.toBeNull();
    expect(leaks(page.commits.slice(from))).toEqual([]);
    expect(settled()).toEqual({ toolbar: undefined, toolbarName: undefined, empty: undefined });
  });

  it('an older board denial landing after a newer read admitted leaves the newer answer’s client', async () => {
    const page = await projectsPage();
    const older = held();
    const newer = held();
    page.serve.board = () => older.response;
    await page.invalidate();
    page.serve.board = () => newer.response;
    page.serve.project = answer(ON_B);
    await page.invalidate();
    newer.release(EMPTY);
    await tick();
    older.release(DENIED);
    await tick();
    await tick();
    expect(page.view.find('[data-outcome="denied"]')).toBeNull();
    expect(settled()).toEqual({ toolbar: OTHER, toolbarName: 'Client B', empty: OTHER });
  });
});

describe('a project answer and the board’s denial answering in either order', () => {
  it('a project answer landing after the board’s denial names no client on either door', async () => {
    const page = await projectsPage();
    const board = held();
    const project = held();
    page.serve.board = () => board.response;
    page.serve.project = () => project.response;
    await page.invalidate();
    const from = page.commits.length;
    board.release(DENIED);
    await tick();
    project.release(ON_B);
    await tick();
    await tick();
    expect(leaks(page.commits.slice(from))).toEqual([]);
    expect(named(page.commits, from + 1)).toEqual([]);
    expect(settled()).toEqual({ toolbar: undefined, toolbarName: undefined, empty: undefined });
  });

  it('a project answer landing before the board’s denial is withdrawn with it', async () => {
    const page = await projectsPage();
    const board = held();
    const project = held();
    page.serve.board = () => board.response;
    page.serve.project = () => project.response;
    await page.invalidate();
    project.release(ON_B);
    await tick();
    // The board still admits on its previous answer, so the new client may show.
    expect(settled().empty).toBe(OTHER);
    const from = page.commits.length;
    board.release(DENIED);
    await tick();
    await tick();
    expect(leaks(page.commits.slice(from))).toEqual([]);
    expect(settled()).toEqual({ toolbar: undefined, toolbarName: undefined, empty: undefined });
  });
});

describe('a project answer minted before a denial and landing after re-admission', () => {
  it('is dropped when a task panel change re-admits the reader', async () => {
    const page = await projectsPage();
    const across = await denyWithProjectHeld(page);
    page.serve.board = answer(EMPTY);
    page.serve.project = answer(ON_B);
    const before = page.reads.project;
    const from = page.commits.length;
    await page.panelChange();
    across.release(ON_A);
    await tick();
    await tick();
    expect(page.reads.project).toBe(before + 1);
    expect(named(page.commits, from).filter((one) => one === CLIENT)).toEqual([]);
    expect(settled()).toEqual({ toolbar: OTHER, toolbarName: 'Client B', empty: OTHER });
  });

  it('is dropped when the live channel re-admits the reader', async () => {
    const page = await projectsPage();
    const across = await denyWithProjectHeld(page);
    page.serve.board = answer(EMPTY);
    page.serve.project = answer(ON_B);
    const from = page.commits.length;
    await page.invalidate();
    across.release(ON_A);
    await tick();
    await tick();
    expect(named(page.commits, from).filter((one) => one === CLIENT)).toEqual([]);
    expect(settled()).toEqual({ toolbar: OTHER, toolbarName: 'Client B', empty: OTHER });
  });
});

describe('a project answer minted before a denial and landing after a Retry re-admits', () => {
  it('is dropped when the board’s Retry re-admits the reader after a denial then an outage', async () => {
    const page = await projectsPage();
    const across = await denyWithProjectHeld(page);
    const gate = held();
    page.serve.board = outage(gate);
    await page.panelChange();
    gate.release(null);
    await tick();
    expect(page.view.find('[data-outcome="unavailable"]')).not.toBeNull();
    page.serve.board = answer(EMPTY);
    page.serve.project = answer(ON_B);
    const from = page.commits.length;
    await page.retry();
    across.release(ON_A);
    await tick();
    await tick();
    expect(leaks(page.commits.slice(from))).toEqual([]);
    expect(named(page.commits, from).filter((one) => one === CLIENT)).toEqual([]);
    expect(settled()).toEqual({ toolbar: OTHER, toolbarName: 'Client B', empty: OTHER });
  });
});
