// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, expect, it } from 'vitest';
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

import {
  settleEditedPriority,
  readWithEditedPriority,
} from './priority-settings-custody-support.tsx';

it('lost-answer retry preserves exact body/op/revision; fresh operation follows definitive stale settlement', async () => {
  const world = prioritySettingsWorld();
  const page = await mount(priorityScreen(world));
  try {
    await tick();
    await choosePriority(page, 'sales');
    world.next = 'lost';
    await page.click('[data-settings="save-priority"]');
    await tick();
    const original = priorityWrites(world)[0]?.body;
    expect(original).toMatchObject({ value: ['trust', 'sales'], expectedRevision: 7 });
    world.next = 'stale';
    await page.click('[data-settings="save-priority"]');
    await tick();
    expect(priorityWrites(world)[1]?.body).toStrictEqual(original);
    expect(priorityWrites(world)).toHaveLength(2);
    await page.click('[data-settings="confirm-priority"]');
    await tick();
    expect(priorityWrites(world)[2]?.body).toMatchObject({
      value: ['trust', 'sales'],
      expectedRevision: 8,
    });
    expect(priorityWrites(world)[2]?.body['operationId']).not.toBe(original?.['operationId']);
  } finally {
    await page.unmount();
  }
});

it('a scope refusal after unknown closes authority but retains uncertainty about the original effect', async () => {
  const world = prioritySettingsWorld();
  const page = await mount(priorityScreen(world));
  try {
    await tick();
    await choosePriority(page, 'sales');
    world.next = 'stored-lost';
    await page.click('[data-settings="save-priority"]');
    await tick();
    const original = priorityWrites(world)[0]?.body;
    expect(world.value).toStrictEqual(['trust', 'sales']);
    expect(world.effects).toBe(1);
    expect(page.find('[data-settings="priority-unknown"]')).not.toBeNull();
    world.next = 'scope';
    await page.click('[data-settings="save-priority"]');
    await tick();
    expect(priorityWrites(world)[1]?.body).toStrictEqual(original);
    expect(prioritySave(page).disabled).toBe(true);
    expect(page.find('[data-settings="priority-unknown"]')).not.toBeNull();
    await page.click('[data-settings="save-priority"]');
    await tick();
    expect(priorityWrites(world)).toHaveLength(2);
    expect(world.effects).toBe(1);
  } finally {
    await page.unmount();
  }
});

it('late Alpha write cannot change Bravo readback or Bravo unsent choices', async () => {
  const alpha = prioritySettingsWorld();
  const bravo = prioritySettingsWorld('bravo');
  bravo.value = ['awareness'];
  bravo.revision = 3;
  const page = await mount(priorityScreen(alpha));
  try {
    await tick();
    await choosePriority(page, 'sales');
    alpha.next = 'held';
    await page.click('[data-settings="save-priority"]');
    await tick();
    expect(priorityWrites(alpha)).toHaveLength(1);
    await page.render(priorityScreen(bravo, 'bravo:ada:0'));
    await tick();
    expect(priorityInput(page, 'awareness').checked).toBe(true);
    expect(priorityInput(page, 'sales').checked).toBe(false);
    await choosePriority(page, 'advocacy');
    const dirty = priorityInput(page, 'advocacy');
    alpha.releaseWrite();
    await tick();
    expect(priorityInput(page, 'advocacy')).toBe(dirty);
    expect(dirty.checked).toBe(true);
    expect(page.find('[data-settings="priority-value"]')?.textContent).toContain('Awareness');
    expect(page.find('[data-settings="priority-value"]')?.textContent).not.toContain('Sales');
    expect(priorityWrites(bravo)).toHaveLength(0);
    await page.click('[data-settings="save-priority"]');
    await tick();
    expect(priorityWrites(bravo)[0]?.body).toMatchObject({
      value: ['awareness', 'advocacy'],
      expectedRevision: 3,
    });
    expect(priorityWrites(bravo)[0]?.body['operationId']).not.toBe(
      priorityWrites(alpha)[0]?.body['operationId'],
    );
  } finally {
    alpha.releaseWrite();
    await tick();
    await page.unmount();
  }
});

it('unknown retries keep the original envelope across edited choices and a newer same-owner read', async () => {
  const world = prioritySettingsWorld();
  const page = await mount(priorityScreen(world));
  try {
    await tick();
    await choosePriority(page, 'sales');
    world.next = 'lost';
    await page.click('[data-settings="save-priority"]');
    await tick();
    const original = priorityWrites(world)[0]?.body;
    expect(original).toMatchObject({ value: ['trust', 'sales'], expectedRevision: 7 });
    expect(typeof original?.['operationId']).toBe('string');
    expect(priorityWrites(world)).toHaveLength(1);
    expect(page.find('[data-settings="priority-unknown"]')).not.toBeNull();
    const dirty = await readWithEditedPriority(world, page);
    world.next = 'lost';
    await page.click('[data-settings="save-priority"]');
    await tick();
    expect(priorityWrites(world)[1]?.body).toStrictEqual(original);
    expect(priorityWrites(world)).toHaveLength(2);
    expect(priorityInput(page, 'advocacy')).toBe(dirty);
    expect(dirty.checked).toBe(true);
    expect(page.find('[data-settings="priority-unknown"]')).not.toBeNull();
    await choosePriority(page, 'awareness');
    world.next = 'lost';
    await page.click('[data-settings="save-priority"]');
    await tick();
    expect(priorityWrites(world)[2]?.body).toStrictEqual(original);
    expect(priorityWrites(world)).toHaveLength(3);
    expect(priorityInput(page, 'awareness').checked).toBe(true);
    expect(priorityInput(page, 'advocacy')).toBe(dirty);
    expect(dirty.checked).toBe(true);
    expect(world.effects).toBe(0);
    await settleEditedPriority(world, page, original, dirty);
  } finally {
    await page.unmount();
  }
});
