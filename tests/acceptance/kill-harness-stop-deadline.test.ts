// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { awaitStopped } from './kill-harness.ts';

it('a stop first reached after two seconds fails the process proof', async () => {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const started = performance.now();
  const seen = await awaitStopped(1, 2_000, () => {
    // A slow state read cannot establish that the process stopped before the deadline.
    Atomics.wait(pause, 0, 0, 1_100);
    return performance.now() - started < 2_000 ? 'S' : 'T';
  });
  expect(seen.stopped, seen.probes.join(', ')).toBe(false);
});
