// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// #1710: an open task whose live stream stays quiet still shows a run no
// runner took once its bound passes, sending no launch or restart itself.
// From Sol's review; the fake clock starts before the panel
// mounts, so the timer the panel sets is on it.
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { panel, serving } from './panel-fields-support.tsx';
import { unmountAll } from './perspective-support.tsx';

afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
});

it('a quiet healthy stream still shows a run no runner took once its bound passes', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const launchedAt = Date.now();
  const server = serving({
    agent: {
      agentId: 'a-1',
      name: 'Reply drafter',
      owner: { personId: 'p-ada', name: 'Ada' },
      live: true,
      get run() {
        return {
          state: Date.now() - launchedAt >= 15 * 60_000 ? 'unanswered' : 'waiting',
          launchedAt: new Date(launchedAt).toISOString(),
          boundLeftMs: Math.max(0, launchedAt + 15 * 60_000 - Date.now()),
        };
      },
    },
    myAgents: [],
  });
  // A connected, quiet SSE stream: no runner writes and no unrelated task changes.
  server.client.openLive = () => Promise.resolve(new ReadableStream<Uint8Array>());
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

it("asks again a minute later when the server's clock says the bound has not passed", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const launchedMs = Date.now();
  const launchedAt = new Date(launchedMs).toISOString();
  const asked = { reads: 0 };
  const server = serving({
    agent: {
      agentId: 'a-1',
      name: 'Reply drafter',
      owner: { personId: 'p-ada', name: 'Ada' },
      live: true,
      get run() {
        asked.reads += 1;
        // Still waiting by this server's account, with its time left run out.
        return {
          state: 'waiting',
          launchedAt,
          boundLeftMs: Math.max(0, launchedMs + 15 * 60_000 - Date.now()),
        };
      },
    },
    myAgents: [],
  });
  server.client.openLive = () => Promise.resolve(new ReadableStream<Uint8Array>());
  const view = await panel(server.client);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(16 * 60_000);
  });
  const atBound = asked.reads;
  expect(atBound).toBeGreaterThan(0);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(61_000);
  });
  expect(asked.reads).toBeGreaterThan(atBound);
  expect(view.find('[data-run-state]')?.textContent).toBe('Run waiting for the runner');
});
