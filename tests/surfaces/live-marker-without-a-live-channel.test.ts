// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A deployment with no live channel (a hosted function: the live route is not
// mounted, so the join answers a bare 404) is not a stream that dropped. The
// page keeps its 30-second checked reread, and the header says how fresh that
// read is, not "Reconnecting". A refused join is still a stream that is down.

import { afterEach, expect, it, vi } from 'vitest';
import { freshnessOf } from '../../packages/ui/src/state/freshness.ts';
import { createLiveHub, FLOOR_MS, type LiveChange } from '../../apps/web/src/data/live.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';

afterEach(() => {
  vi.useRealTimers();
});

const clientAnswering = (response: () => Response) =>
  new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    sessionId: '0123456789abcdef0123456789abcdef',
    fetch: async () => await Promise.resolve(response()),
  });

it('a live join answered by a bare not found says the deployment has no live channel', async () => {
  const signal = new AbortController().signal;
  const none = clientAnswering(() => new Response('404 Not Found', { status: 404 }));
  expect(await none.openLive(['board'], signal)).toBe('no-channel');

  const refused = clientAnswering(() =>
    Response.json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, { status: 404 }),
  );
  expect(
    await refused.openLive(['board'], signal),
    'a refusal is not a missing channel',
  ).toBeNull();
});

it('with no live channel a visible page rereads on the floor and its marker reads updated, not reconnecting', async () => {
  vi.useFakeTimers();
  const hub = createLiveHub(async () => await Promise.resolve('no-channel' as const), {
    visible: () => true,
  });
  const heard: LiveChange[] = [];
  const stop = hub.follow('board', (change) => heard.push(change));
  try {
    await vi.advanceTimersByTimeAsync(2 * FLOOR_MS);
    expect(heard, 'the page is reread on the floor').toEqual(['changed', 'changed']);
    expect(hub.downSince, 'no stream dropped').toBeNull();

    const now = Date.now();
    const marker = freshnessOf(
      {
        denied: false,
        frozenAt: null,
        online: true,
        streamDownSince: hub.downSince,
        failingSince: null,
        lastReadAt: now - 10_000,
        changedAt: null,
        source: null,
      },
      now,
      'UTC',
    );
    expect(marker).toEqual({ state: 'live', age: 'just now' });
  } finally {
    stop();
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(vi.getTimerCount(), 'no floor is left once no page follows').toBe(0);
});

it('a refused live join still counts as the stream being down', async () => {
  vi.useFakeTimers();
  const hub = createLiveHub(async () => await Promise.resolve(null), { visible: () => true });
  const stop = hub.follow('board', () => {});
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(hub.downSince).not.toBeNull();
  } finally {
    stop();
    await vi.advanceTimersByTimeAsync(0);
  }
});
