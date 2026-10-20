// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { doorContext } from '../../apps/web/src/screens/task/task-prefill.ts';
import {
  BOARD,
  CLIENT,
  ON_B,
  OTHER,
  emptyDoor,
  projectsPage,
  toolbarDoor,
} from './project-door-client-race-support.tsx';
import { tick } from './task-page-stub.tsx';
import { held } from './work-log-stand-in.tsx';

afterEach(() => window.history.replaceState(null, '', '/'));

it('a selected project refresh cannot file its former client through a Client filter', async () => {
  const address = `/projects/?board=${BOARD}&f=${encodeURIComponent('client:"Client A"')}`;
  const page = await projectsPage(address);
  expect(toolbarDoor()?.dataset['newTaskClient']).toBe(CLIENT);
  const refresh = held();
  page.serve.project = () => refresh.response;
  await page.invalidate();
  expect(page.reads.board).toBe(2);
  expect(page.reads.project).toBe(2);
  expect(page.view.find('[data-outcome="denied"]')).toBeNull();
  const during = [toolbarDoor(), emptyDoor()].map((door) =>
    door === null ? null : doorContext(door).clientId,
  );
  refresh.release(ON_B);
  await tick();
  await tick();
  expect(toolbarDoor()?.dataset['newTaskClient']).toBe(OTHER);
  expect(emptyDoor()?.dataset['newTaskClient']).toBe(OTHER);
  expect(during, 'a draft opened during the live reread must not file the former client').toEqual([
    null,
    null,
  ]);
});
