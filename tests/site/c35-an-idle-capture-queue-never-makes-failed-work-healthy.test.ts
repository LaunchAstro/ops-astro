// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2013): the review captures are spare work. A pass whose locate and corrections both
// failed fails, and pings no heartbeat, however the captures went. Sol's proof (S2147-1).

import { afterEach, expect, it, vi } from 'vitest';
import { passes, passFor } from '../../apps/site-runner/main.ts';

afterEach(() => vi.restoreAllMocks());

it('C35 an idle capture queue never makes a failed locate and failed corrections healthy', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const stopping = new AbortController();
  let pings = 0;
  await passes({
    pass: passFor(false, {
      locate: async () => await Promise.reject(new Error('locate unavailable')),
      claims: async () => await Promise.reject(new Error('correction executor unavailable')),
      captures: async () => await Promise.resolve([]),
    }),
    ping: async () => void (await Promise.resolve((pings += 1))),
    sleep: async () => void (await Promise.resolve(stopping.abort())),
    stopping: stopping.signal,
  });
  expect(pings).toBe(0);
});
