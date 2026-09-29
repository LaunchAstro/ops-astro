// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C4 on the page: the tab's one live stream. Pages follow topics, counted by
// reference; the stream is joined naming all of them and joined again when the
// set changes; an event re-reads only the pages on its topic, and only while
// the tab is visible, except `closed`, which re-reads at once and leaves that
// topic off the next join. The stream's status is what the freshness marker
// reads.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLiveHub, FLOOR_MS, type LiveChange } from '../../apps/web/src/data/live.ts';
import { freshnessOf, type LiveStatus } from '../../packages/ui/src/index.ts';

const settle = async (): Promise<void> => {
  for (let n = 0; n < 5; n += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};

interface Join {
  readonly topics: readonly string[];
  readonly signal: AbortSignal;
  send(event: string, topic: string): void;
  end(): void;
}

/** A server whose joins the case can see, write events into and end. */
function server(reachable = true) {
  const joins: Join[] = [];
  const encoder = new TextEncoder();
  const open = async (topics: readonly string[], signal: AbortSignal) => {
    if (!reachable) return null;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    joins.push({
      topics: [...topics],
      signal,
      send: (event, topic) =>
        controller?.enqueue(encoder.encode(`event: ${event}\ndata: ${topic}\n\n`)),
      end: () => controller?.close(),
    });
    return await Promise.resolve(body);
  };
  return { joins, open };
}

function page() {
  const heard: LiveChange[] = [];
  return { heard, onChange: (change: LiveChange) => heard.push(change) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('C4 one event stream per tab', () => {
  it('C4 one stream per tab: pages share one stream, a new topic joins again naming every topic, and the last to leave ends it', async () => {
    const api = server();
    const hub = createLiveHub(api.open, { visible: () => true });
    const [a, b, alsoA, c] = [page(), page(), page(), page()];
    const stops = [
      hub.follow('task:a', a.onChange),
      hub.follow('task:b', b.onChange),
      hub.follow('task:a', alsoA.onChange),
    ];
    await settle();
    expect(api.joins.map((join) => join.topics)).toEqual([['task:a', 'task:b']]);

    api.joins[0]?.send('invalidate', 'task:b');
    await settle();
    expect([a.heard, b.heard, alsoA.heard]).toEqual([[], ['changed'], []]);
    api.joins[0]?.send('invalidate', 'task:a');
    api.joins[0]?.send('invalidate', 'task:elsewhere');
    await settle();
    expect([a.heard, b.heard, alsoA.heard]).toEqual([['changed'], ['changed'], ['changed']]);

    stops.push(hub.follow('task:c', c.onChange));
    await settle();
    expect(api.joins.map((join) => join.topics)).toEqual([
      ['task:a', 'task:b'],
      ['task:a', 'task:b', 'task:c'],
    ]);
    expect(api.joins[0]?.signal.aborted).toBe(true);

    // One of two pages on a topic leaving changes nothing on the wire.
    stops[2]?.();
    await settle();
    expect(api.joins).toHaveLength(2);
    for (const stop of stops) stop();
    await settle();
    expect(api.joins).toHaveLength(2);
    expect(api.joins[1]?.signal.aborted).toBe(true);
  });

  it('C4 live-sync 2: with the transport off, a visible page re-reads within 30 s and at once on focus', async () => {
    vi.useFakeTimers();
    const hub = createLiveHub(server(false).open, { visible: () => true });
    const a = page();
    const stop = hub.follow('task:a', a.onChange);
    await vi.advanceTimersByTimeAsync(FLOOR_MS - 1);
    expect(a.heard).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(a.heard).toEqual(['changed']);
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    expect(a.heard).toEqual(['changed', 'changed', 'changed']);
    stop();
  });

  it('C4 live-sync 3: a hidden tab makes no reads and re-reads at once on return', async () => {
    let visible = false;
    const api = server();
    const hub = createLiveHub(api.open, { visible: () => visible });
    const [a, b] = [page(), page()];
    const stops = [hub.follow('task:a', a.onChange), hub.follow('task:b', b.onChange)];
    await settle();
    for (const event of ['resync', 'invalidate', 'invalidate']) api.joins[0]?.send(event, 'task:a');
    await settle();
    expect([a.heard, b.heard]).toEqual([[], []]);

    visible = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect([a.heard, b.heard]).toEqual([['changed'], ['changed']]);
    for (const stop of stops) stop();
  });

  it('C4 live-sync 5 (page): a closed topic re-reads even in a hidden tab, and is left off the next join until its pages have gone', async () => {
    const api = server();
    const hub = createLiveHub(api.open, { visible: () => false });
    const [a, b, c] = [page(), page(), page()];
    const stopA = hub.follow('task:a', a.onChange);
    const stopB = hub.follow('task:b', b.onChange);
    await settle();
    api.joins[0]?.send('closed', 'task:b');
    await settle();
    expect([a.heard, b.heard]).toEqual([[], ['closed']]);

    const stopC = hub.follow('task:c', c.onChange);
    await settle();
    expect(api.joins.at(-1)?.topics).toEqual(['task:a', 'task:c']);

    stopB();
    const again = hub.follow('task:b', b.onChange);
    await settle();
    expect(api.joins.at(-1)?.topics).toEqual(['task:a', 'task:b', 'task:c']);
    for (const stop of [stopA, stopC, again]) stop();
  });

  it('C4 the stream’s status feeds the freshness marker: catching up while it is down, live once joined again', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const api = server();
    const hub = createLiveHub(api.open, { visible: () => true });
    const stop = hub.follow('task:a', () => {});
    await vi.advanceTimersByTimeAsync(0);
    const status = (): LiveStatus => ({
      denied: false,
      frozenAt: null,
      online: true,
      streamDownSince: hub.downSince,
      failingSince: null,
      lastReadAt: Date.now(),
      changedAt: null,
      source: null,
    });
    expect(freshnessOf(status(), Date.now(), 'UTC')?.state).toBe('live');

    api.joins[0]?.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(hub.downSince).toBe(Date.now());
    expect(freshnessOf(status(), Date.now(), 'UTC')?.state).toBe('catching-up');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.joins).toHaveLength(2);
    expect(hub.downSince).toBeNull();
    expect(freshnessOf(status(), Date.now(), 'UTC')?.state).toBe('live');
    stop();
  });
});
