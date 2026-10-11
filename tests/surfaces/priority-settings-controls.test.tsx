// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, expect, it } from 'vitest';
import { TASK_STAGES } from '../../packages/core-wire/src/index.ts';
import { mount } from './mount.tsx';
import { tick } from './settings-four-eyes-world.tsx';
import {
  prioritySettingsWorld,
  priorityScreen,
  priorityWrites,
  priorityInput,
  prioritySave,
  choosePriority,
} from './priority-settings-world.tsx';

beforeEach(() => {
  window.sessionStorage.clear();
});

it('offers the six journey stages, and an empty setting reads as none', async () => {
  const world = prioritySettingsWorld();
  world.value = [];
  const page = await mount(priorityScreen(world));
  try {
    await tick();
    const journeys = TASK_STAGES.list().filter((one) => !one.internal);
    expect(journeys.map((one) => one.id)).toStrictEqual([
      'awareness',
      'trust',
      'enquiries',
      'sales',
      'retention',
      'advocacy',
    ]);
    const controls = page.all('[data-settings="priority-stages"] input[type="checkbox"]');
    expect(controls).toHaveLength(6);
    for (const stage of journeys) {
      const input = priorityInput(page, stage.id);
      expect(input.checked).toBe(false);
      expect(page.find(`label[for="${input.id}"]`)?.textContent).toContain(stage.label);
    }
    expect(page.find('[data-settings="priority-stages"] input[value="ops"]')).toBeNull();
    expect(page.find('[data-settings="priority-stages"] input[type="text"]')).toBeNull();
    expect(page.find('[data-settings="priority-value"]')?.textContent).toMatch(/none/iu);
    expect(page.find('[data-settings="priority-updated"]')?.textContent).toContain('revision 7');
    expect(priorityWrites(world)).toHaveLength(0);
  } finally {
    await page.unmount();
  }
});

it('Save sends the chosen ids and the revision read; unticking every stage clears them', async () => {
  const world = prioritySettingsWorld();
  const page = await mount(priorityScreen(world));
  try {
    await tick();
    await choosePriority(page, 'sales');
    expect(page.find('[data-settings="priority-value"]')?.textContent).not.toContain('Sales');
    await page.click('[data-settings="save-priority"]');
    await tick();
    const first = priorityWrites(world)[0]?.body;
    expect(first).toMatchObject({ value: ['trust', 'sales'], expectedRevision: 7 });
    expect(Object.keys(first ?? {}).toSorted()).toStrictEqual([
      'expectedRevision',
      'operationId',
      'value',
    ]);
    expect(page.find('[data-settings="priority-value"]')?.textContent).toContain('Trust, Sales');
    await choosePriority(page, 'trust');
    await choosePriority(page, 'sales');
    expect(priorityWrites(world)).toHaveLength(1);
    await page.click('[data-settings="save-priority"]');
    await tick();
    expect(priorityWrites(world)[1]?.body).toMatchObject({ value: [], expectedRevision: 8 });
    expect(priorityWrites(world)[1]?.body['operationId']).not.toBe(first?.['operationId']);
    expect(page.find('[data-settings="priority-value"]')?.textContent).toMatch(/none/iu);
  } finally {
    await page.unmount();
  }
});

for (const caps of ['without-manage', 'denied'] as const) {
  it(`holds the priority controls when capabilities are ${caps}`, async () => {
    const world = prioritySettingsWorld();
    world.caps = caps;
    const page = await mount(priorityScreen(world));
    try {
      await tick();
      expect(prioritySave(page).disabled).toBe(true);
      await page.click('[data-settings="save-priority"]');
      await tick();
      expect(priorityWrites(world)).toHaveLength(0);
    } finally {
      await page.unmount();
    }
  });
}

it('a stale save keeps the ticked stages; only an explicit overwrite sends the new revision', async () => {
  const world = prioritySettingsWorld();
  const page = await mount(priorityScreen(world));
  try {
    await tick();
    await choosePriority(page, 'sales');
    const dirty = priorityInput(page, 'sales');
    dirty.focus();
    world.next = 'stale';
    await page.click('[data-settings="save-priority"]');
    await tick();
    expect(priorityWrites(world)).toHaveLength(1);
    expect(priorityInput(page, 'sales')).toBe(dirty);
    expect(dirty.checked).toBe(true);
    expect(page.find('[data-settings="conflict-server"]')?.textContent).toContain('Retention');
    expect(page.find('[data-settings="conflict-draft"]')?.textContent).toContain('Sales');
    await page.click('[data-settings="confirm-priority"]');
    await tick();
    const writes = priorityWrites(world);
    expect(writes[1]?.body).toMatchObject({ value: ['trust', 'sales'], expectedRevision: 8 });
    expect(writes[1]?.body['operationId']).not.toBe(writes[0]?.body['operationId']);
  } finally {
    await page.unmount();
  }
});
