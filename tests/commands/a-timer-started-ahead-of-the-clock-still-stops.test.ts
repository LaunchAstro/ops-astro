// SPDX-License-Identifier: AGPL-3.0-only
//
// A timer starts at the transaction's `now()` and stops at `clock_timestamp()`,
// so its end follows its start while the database clock only moves forward.
// When the clock steps back (a VM clock resynced under load, an NTP step), a
// running entry's start can sit ahead of the clock that stops it. `time.stop`
// still stops it: it ends at its own start, one minute, and the timer is off,
// never a 500 on `time_entries_ends_after_start` with the timer left running
// (#2386). The step is planted by moving the open entry's start ahead.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { outcomeOf, timeWorld, type TimeWorld } from './time-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'a-timer-started-ahead-of-the-clock-still-stops: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

let w: TimeWorld;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await timeWorld('tahead');
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

describe.skipIf(serverUrl === undefined)('a timer whose start is ahead of the clock', () => {
  it('time.stop ends it at its own start, one minute, and the timer is off', async () => {
    const task = await w.fresh(w.alpha, w.ada, 'clock stepped back');
    const started = await w.as(w.alpha, w.ada, { command: 'time.start', taskId: task });
    expect(outcomeOf(started)).toStrictEqual({ applied: true });
    // The clock steps back five minutes after the start.
    const [ahead] = await w.db.admin.execute<{ readonly started_at: Date }>(
      `update public.time_entries set started_at = clock_timestamp() + interval '5 minutes'
        where person_id = $1 and task_id = $2 and ended_at is null
        returning started_at`,
      [w.ada.personId, task],
    );
    expect(ahead).toBeDefined();

    const stopped = await w.as(w.alpha, w.ada, { command: 'time.stop', taskId: task });
    expect(outcomeOf(stopped)).toStrictEqual({ applied: true });

    const [entry] = await w.db.admin.execute<{
      readonly started_at: Date;
      readonly ended_at: Date | null;
      readonly minutes: number | null;
    }>(
      `select started_at, ended_at, minutes from public.time_entries
        where person_id = $1 and task_id = $2`,
      [w.ada.personId, task],
    );
    expect(entry?.ended_at?.toISOString()).toBe(ahead?.started_at.toISOString());
    expect(entry?.minutes).toBe(1);

    // The timer is off: a new one starts.
    const again = await w.as(w.alpha, w.ada, { command: 'time.start', taskId: task });
    expect(outcomeOf(again)).toStrictEqual({ applied: true });
    await w.as(w.alpha, w.ada, { command: 'time.stop', taskId: task });
  });
});
