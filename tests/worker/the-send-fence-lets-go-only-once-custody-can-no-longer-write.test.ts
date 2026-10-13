// SPDX-License-Identifier: AGPL-3.0-only
//
// The send fence holds the call's locks until custody has written or can no
// longer write. Custody may still write at the deadline itself (the accept
// plus W), so the function may let go only once its own clock is past the
// accept as heard plus W. When the function hears the accept in the same
// millisecond the agent stamped it, on a clock that agrees, its "W after the
// accept was heard" is that same instant: letting go at it, rather than after
// it, leaves custody one instant in which it writes to the model with no lock
// held, after an ending could have committed.

import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { openRaceWorld, type RaceWorld } from './carried-race-world.ts';

let world: RaceWorld | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

it('custody connecting at the deadline itself writes only while the fence still holds', async () => {
  const opened = await openRaceWorld();
  world = opened;
  // One clock for the function, the agent and custody, still until the case moves it.
  opened.clock.at = Date.now();
  await opened.startAgent(async (gate) => {
    // The hand-over reaches custody's connect at the deadline itself.
    opened.clock.at = gate.deadlineAt;
    await Promise.race([opened.noted('released'), sleep(1_000)]);
  });
  const outcome = await opened.carry();
  expect(outcome.kind).not.toBe('worker_lost');
  const released = opened.order.indexOf('released');
  expect(released).toBeGreaterThanOrEqual(0);
  // Nothing reached the model once the fence had let its locks go.
  expect(opened.order.slice(released + 1)).not.toContain('written');
}, 15_000);
