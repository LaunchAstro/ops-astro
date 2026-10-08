// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { copied, realm } from './task-timer-recovery-support.tsx';
import { timerWorld } from './task-bound-timer-support.tsx';

const TIMER = 'ops-astro.task-timer';
const strip = '[data-task-timer-strip]';
const pageTimer = 'main [data-time-log-section] [data-timer]';

for (const corrupted of ['task', 'operation', 'guard', 'entry'] as const) {
  it(`a noncanonical stored ${corrupted} cannot become a timer control or command`, async () => {
    const world = timerWorld();
    const first = await realm(world.fetch);
    await first.view.click(pageTimer);
    world.loseStop();
    await first.view.click(`${strip} [data-timer]`);
    const storage = copied(first.storage);
    const record = JSON.parse(storage.getItem(TIMER)!);
    if (corrupted === 'task') record.attempt.payload.taskId = 'Timer-B';
    if (corrupted === 'operation') record.attempt.operationId = 'other-operation';
    if (corrupted === 'guard') record.attempt.payload.expectedEntryId = 'entry-a';
    if (corrupted === 'entry') record.binding.running.entryId = 'entry-a';
    storage.setItem(TIMER, JSON.stringify(record));
    await first.view.unmount();
    const before = world.writes().length;
    const second = await realm(world.fetch, storage, '/projects');
    expect(second.view.find(strip)?.textContent).toBe('Select task to time');
    expect(second.view.find('[data-task-timer-retry]')).toBeNull();
    expect(world.writes()).toHaveLength(before);
  });
}
