// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The ticked priority stages are a whole set built on the row read when the
// first box was ticked. Save sends that row's revision, so a change another
// administrator made since is a conflict, not silently replaced; with no row
// read there is nothing to build on, so nothing is sent.

import { beforeEach, expect, it } from 'vitest';
import { mount } from './mount.tsx';
import { tick } from './settings-four-eyes-world.tsx';
import {
  choosePriority,
  prioritySave,
  priorityScreen,
  prioritySettingsWorld,
  priorityWrites,
} from './priority-settings-world.tsx';

beforeEach(() => {
  window.sessionStorage.clear();
});

it('a draft started before another administrator saved meets the conflict after a reread', async () => {
  const world = prioritySettingsWorld();
  const page = await mount(priorityScreen(world));
  try {
    await tick();
    await choosePriority(page, 'sales');
    // Another administrator saves Retention; this screen's sign-off save rereads.
    world.value = ['retention'];
    world.revision = 8;
    await page.click('[data-settings="save-sign-off"]');
    await tick();
    expect(page.find('[data-settings="priority-value"]')?.textContent).toContain('Retention');
    await page.click('[data-settings="save-priority"]');
    await tick();
    expect(priorityWrites(world)[0]?.body).toMatchObject({ expectedRevision: 7 });
    expect(world.value).toStrictEqual(['retention']);
    expect(page.find('[data-settings="conflict"]')).not.toBeNull();
  } finally {
    await page.unmount();
  }
});

it('a draft started after this screen saved meets the conflict when another save came between', async () => {
  const world = prioritySettingsWorld();
  const page = await mount(priorityScreen(world));
  try {
    await tick();
    await choosePriority(page, 'sales');
    await page.click('[data-settings="save-priority"]');
    await tick();
    expect(world.revision).toBe(8);
    await choosePriority(page, 'advocacy');
    world.value = ['retention'];
    world.revision = 9;
    await page.click('[data-settings="save-sign-off"]');
    await tick();
    expect(page.find('[data-settings="priority-value"]')?.textContent).toContain('Retention');
    await page.click('[data-settings="save-priority"]');
    await tick();
    expect(priorityWrites(world)[1]?.body).toMatchObject({ expectedRevision: 8 });
    expect(world.value).toStrictEqual(['retention']);
    expect(page.find('[data-settings="conflict"]')).not.toBeNull();
  } finally {
    await page.unmount();
  }
});

it('ticks made again before the reread of this screen’s own save are sent at that save’s revision', async () => {
  const world = prioritySettingsWorld();
  const page = await mount(priorityScreen(world));
  try {
    await tick();
    await choosePriority(page, 'sales');
    await page.click('[data-settings="save-priority"]');
    await choosePriority(page, 'advocacy');
    await tick();
    await page.click('[data-settings="save-priority"]');
    await tick();
    expect(priorityWrites(world)[1]?.body).toMatchObject({
      value: ['trust', 'sales', 'advocacy'],
      expectedRevision: 8,
    });
    expect(page.find('[data-settings="conflict"]')).toBeNull();
  } finally {
    await page.unmount();
  }
});

for (const status of [503, 403] as const) {
  it(`sends nothing when the settings read answers ${status}`, async () => {
    const world = prioritySettingsWorld();
    world.value = ['trust', 'retention'];
    world.read = status;
    const page = await mount(priorityScreen(world));
    try {
      await tick();
      await choosePriority(page, 'sales');
      await page.click('[data-settings="save-priority"]');
      await tick();
      expect(prioritySave(page).disabled).toBe(true);
      expect(priorityWrites(world)).toHaveLength(0);
      expect(world.value).toStrictEqual(['trust', 'retention']);
    } finally {
      await page.unmount();
    }
  });
}
