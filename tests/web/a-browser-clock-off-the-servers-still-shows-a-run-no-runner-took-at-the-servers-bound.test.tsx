// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// #1710: an open task asks again at the server's bound however far this
// browser's clock is from the server's. The read answers how long its bound
// had left (`boundLeftMs`, judged by the server's clock), and the panel counts
// from when that answer arrived, so it never sets the server's `launchedAt`
// against its own clock. From Sol's review of 15412d9.
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { panel, serving } from './panel-fields-support.tsx';
import { unmountAll } from './perspective-support.tsx';

afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
});

const BOUND_MS = 15 * 60_000;

/** A server whose clock is `skewMs` from this browser's, with a run it launched as the panel opens. */
function skewed(skewMs: number) {
  const browserStart = Date.now();
  const serverLaunch = browserStart + skewMs;
  const asked = { reads: 0 };
  const server = serving({
    agent: {
      agentId: 'a-1',
      name: 'Reply drafter',
      owner: { personId: 'p-ada', name: 'Ada' },
      live: true,
      get run() {
        asked.reads += 1;
        // Elapsed time advances equally on both clocks.
        const elapsed = Date.now() - browserStart;
        return {
          state: elapsed >= BOUND_MS ? 'unanswered' : 'waiting',
          launchedAt: new Date(serverLaunch).toISOString(),
          boundLeftMs: Math.max(0, BOUND_MS - elapsed),
        };
      },
    },
    myAgents: [],
  });
  // A connected, quiet SSE stream: no runner writes and no unrelated task changes.
  server.client.openLive = () => Promise.resolve(new ReadableStream<Uint8Array>());
  return { server, asked };
}

it('a browser clock behind the server still shows the run unanswered at the server bound', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // The server clock is one hour ahead.
  const { server } = skewed(60 * 60_000);
  const view = await panel(server.client);
  expect(view.find('[data-run-state]')?.textContent).toBe('Run waiting for the runner');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(16 * 60_000);
  });
  expect(server.sent.filter((one) => /\/task\/(launch|restart)$/u.test(one.to))).toHaveLength(0);
  expect(view.find('[data-run-state]')?.textContent).toBe(
    'No runner picked this run up. Launch it again.',
  );
});

it('a browser clock ahead of the server reads the task once, at the server bound', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // The server clock is one hour behind.
  const { server, asked } = skewed(-60 * 60_000);
  const view = await panel(server.client);
  const opened = asked.reads;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(14 * 60_000);
  });
  expect(asked.reads).toBe(opened);
  expect(view.find('[data-run-state]')?.textContent).toBe('Run waiting for the runner');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2 * 60_000);
  });
  expect(asked.reads).toBe(opened + 1);
  expect(view.find('[data-run-state]')?.textContent).toBe(
    'No runner picked this run up. Launch it again.',
  );
});
