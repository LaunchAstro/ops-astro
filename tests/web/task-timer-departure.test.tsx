// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { realm, copied } from './task-timer-recovery-support.tsx';
import { timerWorld } from './task-bound-timer-support.tsx';

const TIMER = 'ops-astro.task-timer';
const strip = '[data-task-timer-strip]';
const pageTimer = 'main [data-time-log-section] [data-timer]';

for (const allWritesFail of [false, true]) {
  it(`owner departure cannot revive A when ${allWritesFail ? 'all storage writes and removals' : 'timer removal'} fails`, async () => {
    const world = timerWorld();
    const first = await realm(world.fetch);
    await first.view.click(pageTimer);
    const kept = first.storage.getItem(TIMER);
    expect(kept).not.toBeNull();
    const remove = first.storage.removeItem;
    const set = first.storage.setItem;
    first.storage.removeItem = (key) => {
      if (allWritesFail || key === TIMER) throw new Error('Synthetic removal denied');
      remove(key);
    };
    first.storage.setItem = (key, value) => {
      if (allWritesFail) throw new Error('Synthetic write denied');
      set(key, value);
    };
    const home = first.sessions.session!;
    await first.act(() => {
      first.sessions.set({ ...home, businessKey: 'bravo' });
      first.sessions.set(home);
    });
    await first.renderPath('/projects');
    await first.tick();
    expect(first.view.find(strip)?.textContent).toContain('Select task to time');
    expect(first.view.text()).toContain('only in this tab');
    expect(first.storage.getItem(TIMER)).toBe(kept);
    expect(world.writes()).toHaveLength(1);
    if (!allWritesFail) {
      const storage = copied(first.storage);
      await first.view.unmount();
      const second = await realm(world.fetch, storage, '/projects');
      expect(second.view.find(strip)?.textContent).toBe('Select task to time');
      expect(world.writes()).toHaveLength(1);
    }
  });
}
