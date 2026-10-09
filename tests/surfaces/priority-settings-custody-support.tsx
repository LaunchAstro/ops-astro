// SPDX-License-Identifier: AGPL-3.0-only
import { expect } from 'vitest';
import type { Mounted } from './mount.tsx';
import { tick } from './settings-four-eyes-world.tsx';
import {
  priorityWrites,
  priorityInput,
  choosePriority,
  type PrioritySettingsWorld,
} from './priority-settings-world.tsx';

/** The explicit fresh write follows a definitive stale answer, not an uncertain retry. */
export async function settleEditedPriority(
  world: PrioritySettingsWorld,
  page: Mounted,
  original: Record<string, unknown> | undefined,
  dirty: HTMLInputElement,
): Promise<void> {
  world.next = 'stale';
  await page.click('[data-settings="save-priority"]');
  await tick();
  expect(priorityWrites(world)[3]?.body).toStrictEqual(original);
  expect(priorityWrites(world)).toHaveLength(4);
  expect(page.find('[data-settings="priority-unknown"]')).toBeNull();
  expect(page.find('[data-settings="priority-updated"]')?.textContent).toContain('revision 12');
  expect(priorityInput(page, 'advocacy')).toBe(dirty);
  expect(dirty.checked).toBe(true);
  for (const stage of ['awareness', 'trust', 'sales', 'advocacy'])
    expect(priorityInput(page, stage).checked).toBe(true);
  expect(priorityInput(page, 'retention').checked).toBe(false);
  expect(world.effects).toBe(0);
  await page.click('[data-settings="save-priority"]');
  await tick();
  const fresh = priorityWrites(world)[4]?.body;
  expect(fresh).toMatchObject({
    value: ['awareness', 'trust', 'sales', 'advocacy'],
    expectedRevision: 12,
  });
  expect(fresh?.['operationId']).not.toBe(original?.['operationId']);
  expect(priorityWrites(world)).toHaveLength(5);
  expect(world.effects).toBe(1);
  expect(world.value).toStrictEqual(['awareness', 'trust', 'sales', 'advocacy']);
}

export async function readWithEditedPriority(
  world: PrioritySettingsWorld,
  page: Mounted,
): Promise<HTMLInputElement> {
  await choosePriority(page, 'advocacy');
  const dirty = priorityInput(page, 'advocacy');
  expect(dirty.checked).toBe(true);
  const readsBefore = world.sent.filter((one) => one.at.endsWith('/settings/read')).length;
  world.value = ['retention'];
  world.revision = 11;
  await page.click('[data-settings="read-priority"]');
  await tick();
  expect(world.sent.filter((one) => one.at.endsWith('/settings/read'))).toHaveLength(
    readsBefore + 1,
  );
  expect(page.find('[data-settings="priority-value"]')?.textContent).toContain('Retention');
  expect(page.find('[data-settings="priority-updated"]')?.textContent).toContain('revision 11');
  expect(priorityInput(page, 'advocacy')).toBe(dirty);
  expect(dirty.checked).toBe(true);
  expect(priorityInput(page, 'trust').checked).toBe(true);
  expect(priorityInput(page, 'sales').checked).toBe(true);
  expect(priorityInput(page, 'retention').checked).toBe(false);
  expect(priorityWrites(world)).toHaveLength(1);
  return dirty;
}
