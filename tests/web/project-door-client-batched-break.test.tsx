// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A board read that breaks (a denial or an outage) and is answered again by
// the rollup floor before React draws the break still retires the project
// read in flight across it: from the batched commit on, no door names the
// project's former client, and only a project read begun after the break
// names the project's client again.

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { doorContext } from '../../apps/web/src/screens/task/task-prefill.ts';
import {
  CLIENT,
  DENIED,
  EMPTY,
  ON_A,
  ON_B,
  OTHER,
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

describe('a board break the floor answers again before any render draws it', () => {
  for (const [kind, broken] of [
    ['denial', answer(DENIED)],
    ['outage', unavailable],
  ] as const)
    it(`after a batched ${kind}, no commit names the former client, and only a fresh project read names the client`, async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const page = await projectsPage();
      expect(toolbarDoor()?.dataset['newTaskClient']).toBe(CLIENT);
      const gate = held();
      page.serve.board = () => gate.response.then(broken);
      const across = held();
      const fresh = held();
      page.serve.project = () => across.response;
      await page.invalidate();
      page.serve.project = () => fresh.response;
      page.serve.board = answer(EMPTY);
      const before = page.reads.project;
      const from = page.commits.length;
      await act(async () => {
        gate.release(null);
        await pause();
        vi.advanceTimersByTime(30_000);
        await pause();
      });
      await tick();
      expect(page.view.find('[data-outcome="empty"]')).not.toBeNull();
      expect(drafted()).toEqual([null, null]);
      across.release(ON_A);
      await tick();
      await tick();
      expect(drafted()).toEqual([null, null]);
      expect(page.reads.project).toBe(before + 1);
      fresh.release(ON_B);
      await tick();
      expect(named(page.commits, from)).not.toContain(CLIENT);
      expect(drafted()).toEqual([OTHER, OTHER]);
    });
});
