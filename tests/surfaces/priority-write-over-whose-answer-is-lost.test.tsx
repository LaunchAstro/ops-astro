// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Write over it, on a priority stages conflict, writes the boxes ticked now at
// the revision the reread showed. Raced here: two tabs writing over one
// conflict at once, answered in both orders; the answer lost before and after
// the server stored it, and after the screen left; and the retry, which must
// reuse the operation id while the outcome is unknown and mint a new one after
// a refusal.

import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsScreen } from '../../apps/web/src/screens/Settings.tsx';
import { store } from '../web/draft-support.tsx';
import { mount, type Mounted } from './mount.tsx';
import { tick } from './settings-four-eyes-world.tsx';
import {
  choosePriority,
  priorityInput,
  priorityScreen,
  prioritySettingsWorld,
  priorityWrites,
  type PrioritySettingsWorld,
} from './priority-settings-world.tsx';

beforeEach(() => {
  window.sessionStorage.clear();
});

const WRITE_OVER = '[data-settings="confirm-priority"]';
const SAVE = '[data-settings="save-priority"]';

/** Another administrator saves after `page` ticked Sales; Save meets the conflict. */
async function toConflict(page: Mounted, world: PrioritySettingsWorld): Promise<void> {
  await tick();
  await choosePriority(page, 'sales');
  world.value = ['retention'];
  world.revision = 8;
  await page.click(SAVE);
  await tick();
  expect(conflicted(page)).toBe(true);
}

const conflicted = (page: Mounted): boolean =>
  page.host.querySelector('[data-settings="conflict"]') !== null;

/** Two tabs, each with its own storage, on one business. */
const tab = (world: PrioritySettingsWorld) => (
  <SettingsScreen client={world.client} grantKey="alpha:ada:0" storage={store()} />
);

const release = async (world: PrioritySettingsWorld, index: number): Promise<void> => {
  await act(async () => {
    world.held[index]?.();
    await Promise.resolve();
  });
  await tick();
};

const reads = (world: PrioritySettingsWorld): number =>
  world.sent.filter((one) => one.at.endsWith('/settings/read')).length;

const idOf = (world: PrioritySettingsWorld, index: number): unknown =>
  priorityWrites(world)[index]?.body['operationId'];

/** Each tab meets the conflict; A ticks Advocacy; both press Write over, answered in `order`. */
async function writeOverInTwoTabs(order: readonly [number, number]): Promise<void> {
  const world = prioritySettingsWorld();
  const a = await mount(tab(world));
  const b = await mount(tab(world));
  try {
    await toConflict(a, world);
    world.revision = 7;
    await toConflict(b, world);
    await choosePriority(a, 'advocacy');
    world.fates.push('hold', 'hold');
    await a.click(WRITE_OVER);
    await b.click(WRITE_OVER);
    await release(world, order[0]);
    await release(world, order[1]);
    expect(world.value).toStrictEqual(['trust', 'sales', 'advocacy']);
    expect([conflicted(a), conflicted(b)]).toStrictEqual([false, true]);
  } finally {
    await a.unmount();
    await b.unmount();
  }
}

describe('two tabs writing over one conflict at once', () => {
  it.each([
    ['in the order sent', 0, 1],
    ['in the reverse order', 1, 0],
  ])('answered %s, the first is stored and the other meets the conflict again', async (_, x, y) => {
    await writeOverInTwoTabs([x, y]);
  });
});

describe('a write over whose answer is lost', () => {
  it('before it reached the server: Save sends the ticked boxes at the reread revision', async () => {
    const world = prioritySettingsWorld();
    const page = await mount(priorityScreen(world));
    try {
      await toConflict(page, world);
      await choosePriority(page, 'advocacy');
      world.fates.push('unreachable');
      await page.click(WRITE_OVER);
      await tick();
      expect(priorityWrites(world)).toHaveLength(1);
      await page.click(SAVE);
      await tick();
      expect(priorityWrites(world).at(-1)?.body).toMatchObject({
        value: ['trust', 'sales', 'advocacy'],
        expectedRevision: 8,
      });
      expect(world.value).toStrictEqual(['trust', 'sales', 'advocacy']);
      expect(conflicted(page)).toBe(false);
    } finally {
      await page.unmount();
    }
  });

  it('after the server stored it: the boxes stay ticked, and Save replays the same operation', async () => {
    const world = prioritySettingsWorld();
    const page = await mount(priorityScreen(world));
    try {
      await toConflict(page, world);
      await choosePriority(page, 'advocacy');
      world.fates.push('lose');
      await page.click(WRITE_OVER);
      await tick();
      expect(world.revision).toBe(9);
      expect(priorityInput(page, 'advocacy').checked).toBe(true);
      await page.click(SAVE);
      await tick();
      expect(idOf(world, 2)).toBe(idOf(world, 1));
      expect(world.revision).toBe(9);
      expect(conflicted(page)).toBe(false);
    } finally {
      await page.unmount();
    }
  });
});

describe('a write over answered after the screen left', () => {
  it('reads nothing more', async () => {
    const world = prioritySettingsWorld();
    const page = await mount(priorityScreen(world));
    await toConflict(page, world);
    world.fates.push('hold');
    await page.click(WRITE_OVER);
    const before = reads(world);
    await page.unmount();
    await release(world, 0);
    expect(reads(world)).toBe(before);
    expect(world.revision).toBe(9);
  });
});

describe('a write over pressed again', () => {
  it('after it met the conflict again is a new operation', async () => {
    const world = prioritySettingsWorld();
    const page = await mount(priorityScreen(world));
    try {
      await toConflict(page, world);
      world.next = 'stale';
      await page.click(WRITE_OVER);
      await tick();
      expect(conflicted(page)).toBe(true);
      await page.click(WRITE_OVER);
      await tick();
      expect(priorityWrites(world)).toHaveLength(3);
      expect(idOf(world, 2)).not.toBe(idOf(world, 1));
      expect(conflicted(page)).toBe(false);
    } finally {
      await page.unmount();
    }
  });
});
