// SPDX-License-Identifier: AGPL-3.0-only
//
// A capture whose resolver never answers: resolving the host spends the hop's
// deadline as the transport does, so the capture settles as a recorded
// timeout instead of waiting for ever.

import { afterEach, expect, it, vi } from 'vitest';
import {
  fencedFetch,
  type FenceRefusal,
  type TransportRequest,
} from '../../packages/core-connectors/src/index.ts';

const ABOUT = 'https://www.example.com/about';

afterEach(() => {
  vi.useRealTimers();
});

it('refuses and records a resolver that never answers as a timeout', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const recorded: FenceRefusal[] = [];
  const seen: TransportRequest[] = [];
  let settled: unknown;
  void fencedFetch(ABOUT, {
    pool: { agencyPages: [ABOUT], otherPages: [], closedPoolReviews: [] },
    resolve: () => new Promise<never>(() => {}),
    transport: (request) => {
      seen.push(request);
      return Promise.resolve({ kind: 'timeout' });
    },
    kind: 'document',
    record: (refusal) => recorded.push(refusal),
  }).then((result) => (settled = result));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(settled).toEqual({ ok: false, code: 'CAPTURE_TIMEOUT' });
  expect(recorded).toEqual([
    { code: 'CAPTURE_TIMEOUT', hop: 0, origin: 'https://www.example.com' },
  ]);
  expect(seen).toHaveLength(0);
});
