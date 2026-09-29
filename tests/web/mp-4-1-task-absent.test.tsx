// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-1: the task page with no task on it (TKM-01 to TKM-04, CS-4.38): an id
// nothing is filed under, an address that named none, no fallback task, and
// the doors back to the board. The header itself is in
// `mp-4-1-task-header.test.tsx`.

import { describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { SCREENS } from '../../apps/web/src/screen-registry.tsx';
import { matchRoute, pathTo } from '../../apps/web/src/routes.ts';
import { mount } from '../surfaces/mount.tsx';
import { NOT_FOUND, found, page, server, tick } from './task-page-stub.tsx';

const unnamedPage = async () =>
  await mount(
    SCREENS['agency:task-unnamed']({
      client: server({}),
      grantKey: 'alpha:member',
      params: {},
      notice: null,
      storage: null,
    }),
  );

describe('MP-4-1 unknown and missing', () => {
  it('an id with no task quotes it exactly as typed, never in capitals', async () => {
    const view = await page('proj-nope-12', { 'proj-nope-12': { body: NOT_FOUND, status: 404 } });
    const said = view.find('[data-absent="unknown"]')?.textContent ?? '';
    expect(said).toContain('No task is filed under “proj-nope-12”');
    expect(said).not.toContain('PROJ-NOPE-12');
    await view.unmount();
  });

  it('a page with no id says none was named, in other words', async () => {
    expect(matchRoute('/task/')?.id).toBe('agency:task-unnamed');
    const view = await unnamedPage();
    const said = view.find('[data-absent="unnamed"]')?.textContent ?? '';
    expect(said).toContain('No task was named');
    const unknown = await page('x', { x: { body: NOT_FOUND, status: 404 } });
    const other = unknown.find('[data-absent="unknown"]')?.textContent ?? '';
    expect(other).not.toBe('');
    expect(said).not.toBe(other);
    await unknown.unmount();
    await view.unmount();
  });
});

describe('MP-4-1 no fallback task', () => {
  it('an unknown id after a found one shows none of the first task', async () => {
    const client = server({ ...found(), 'proj-gone': { body: NOT_FOUND, status: 404 } });
    const view = await mount(
      <TaskDetailScreen client={client} grantKey="alpha:member" taskKey="Proj-Verity-Pacing" />,
    );
    await tick();
    expect(view.text()).toContain('Budget pacing fix');
    await view.render(
      <TaskDetailScreen client={client} grantKey="alpha:member" taskKey="proj-gone" />,
    );
    await tick();
    expect(view.find('[data-absent="unknown"]')).not.toBeNull();
    expect(view.find('[data-task]')).toBeNull();
    expect(view.text()).not.toContain('Budget pacing fix');
    expect(view.text()).not.toContain('Website Projects');
    expect(view.text()).not.toContain('Proj-Verity-Pacing');
    await view.unmount();
  });
});

describe('MP-4-1 CS-4.38 doors', () => {
  it('the crumb goes to the board; the missing states offer it', async () => {
    const board = pathTo('agency:projects-board');
    const view = await page('Proj-Verity-Pacing', found());
    expect(view.find('[data-crumb="projects"]')?.getAttribute('href')).toBe(board);
    await view.unmount();
    const unknown = await page('x', { x: { body: NOT_FOUND, status: 404 } });
    expect(unknown.find('[data-absent] a')?.getAttribute('href')).toBe(board);
    expect(unknown.find('[data-absent] a')?.textContent).toBe('Open the projects board →');
    await unknown.unmount();
    const unnamed = await unnamedPage();
    expect(unnamed.find('[data-absent] a')?.getAttribute('href')).toBe(board);
    await unnamed.unmount();
  });

  it('a refusal other than not-found is still the denied state, quoting its code', async () => {
    const view = await page('x', {
      x: { body: { refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, status: 403 },
    });
    expect(view.find('[data-outcome="denied"]')?.textContent).toContain('SCOPE_NOT_GRANTED');
    expect(view.find('[data-absent="unknown"]')).toBeNull();
    await view.unmount();
  });
});
