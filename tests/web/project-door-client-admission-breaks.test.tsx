// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// Every break in the board's admission retires the project read in flight
// across it, even when the break is answered again before React draws it:
// a scoped board's person list refused, out, or answering without the
// address's person. And a project read sent while the board is denied (by
// the live channel or the rollup floor) never names a client, before or
// after the board admits the reader again.

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
  PERSON,
  WITH_PERSON,
  answer,
  emptyDoor,
  named,
  projectsPage,
  toolbarDoor,
} from './project-door-client-race-support.tsx';
import { tick } from './task-page-stub.tsx';
import { held, pause } from './work-log-stand-in.tsx';

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

const unavailable = () => Promise.resolve(new Response('', { status: 503 }));
const drafted = () =>
  [toolbarDoor(), emptyDoor()].map((door) => (door === null ? null : doorContext(door).clientId));
const toolbarDrafted = () => drafted()[0];

describe('a scoped board’s person list breaks and recovers before any render draws it', () => {
  const AT_PERSON = `/projects/?board=${BOARD}&person=${PERSON}`;
  for (const [kind, broken] of [
    ['refused', answer(DENIED)],
    ['out', unavailable],
    ['answering without the address’s person', answer({ ok: true, persons: [] })],
  ] as const)
    it(`a person list ${kind} retires the project read in flight across it`, async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const page = await projectsPage(AT_PERSON);
      expect(toolbarDrafted()).toBe(CLIENT);
      const gate = held();
      const across = held();
      const fresh = held();
      page.serve.people = () => gate.response.then(broken);
      page.serve.project = () => across.response;
      await page.invalidate();
      page.serve.people = answer(WITH_PERSON);
      page.serve.project = () => fresh.response;
      const from = page.commits.length;
      await act(async () => {
        gate.release(null);
        await pause();
        vi.advanceTimersByTime(30_000);
        await pause();
      });
      await tick();
      across.release(ON_A);
      await tick();
      await tick();
      expect(drafted()).toEqual([null, null]);
      fresh.release(ON_B);
      await tick();
      expect(named(page.commits, from)).not.toContain(CLIENT);
      expect(drafted()).toEqual([OTHER, OTHER]);
    });
});

describe('a project read sent while the board is denied', () => {
  it('a live change’s project read during a denial names no client before or after re-admission', async () => {
    const page = await projectsPage();
    page.serve.board = answer(DENIED);
    await page.invalidate();
    expect(page.view.find('[data-outcome="denied"]')).not.toBeNull();
    const during = held();
    page.serve.project = () => during.response;
    const before = page.reads.project;
    await page.invalidate();
    const sent = page.reads.project;
    const from = page.commits.length;
    during.release(ON_A);
    await tick();
    const fresh = held();
    page.serve.board = answer(EMPTY);
    page.serve.project = () => fresh.response;
    await page.panelChange();
    expect(drafted()).toEqual([null, null]);
    fresh.release(ON_B);
    await tick();
    expect(named(page.commits, from)).not.toContain(CLIENT);
    expect(drafted()).toEqual([OTHER, OTHER]);
    // The live change did send `task.read` during the denial: what it answered names nothing.
    expect(sent).toBe(before + 1);
  });
});

describe('a project read the floor sends while the board is denied', () => {
  it('a project read in flight at re-admission, sent during a denial, names no client when it lands', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const page = await projectsPage();
    page.serve.board = answer(DENIED);
    await page.invalidate();
    const during = held();
    page.serve.project = () => during.response;
    // The floor rereads the project's client during the denial.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await pause();
    });
    await tick();
    const fresh = held();
    page.serve.board = answer(EMPTY);
    page.serve.project = () => fresh.response;
    const from = page.commits.length;
    await page.panelChange();
    during.release(ON_A);
    await tick();
    await tick();
    expect(drafted()).toEqual([null, null]);
    fresh.release(ON_B);
    await tick();
    expect(named(page.commits, from)).not.toContain(CLIENT);
    expect(drafted()).toEqual([OTHER, OTHER]);
  });
});
