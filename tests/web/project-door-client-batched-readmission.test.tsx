// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
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
  projectsPage,
  toolbarDoor,
} from './project-door-client-race-support.tsx';
import { tick } from './task-page-stub.tsx';
import { held, pause } from './work-log-stand-in.tsx';

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

it('a denial and fast floor re-admission cannot restore metadata read before denial', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const page = await projectsPage();
  expect(doorContext(toolbarDoor()!).clientId).toBe(CLIENT);
  const across = held();
  const denial = held();
  page.serve.project = () => across.response;
  page.serve.board = () => denial.response;
  await page.invalidate();
  expect(page.reads.project).toBe(2);
  page.serve.project = answer(ON_B);
  page.serve.board = answer(EMPTY);
  await act(async () => {
    denial.release(DENIED);
    await pause();
    vi.advanceTimersByTime(30_000);
    await pause();
  });
  await tick();
  expect(page.reads.board).toBe(3);
  expect(page.view.find('[data-outcome="empty"]')).not.toBeNull();
  across.release(ON_A);
  await tick();
  await tick();
  const drafts = [toolbarDoor(), emptyDoor()].map((door) => doorContext(door!));
  expect(
    drafts.map((draft) => draft.clientId),
    'the answer minted before denial is retired',
  ).toEqual([OTHER, OTHER]);
  expect(drafts.map((draft) => draft.clientName)).toEqual(['Client B', 'Client B']);
});
