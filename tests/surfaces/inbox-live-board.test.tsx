// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1f on the page: the board screen opens one event stream for the tab
// (`<person prefix><business>/live`, T2f's content-free channel) and never a
// stream per task or per panel. An `invalidate` re-reads the board and an
// `inbox` signal re-reads the inbox and its owed count, with no refresh.
// While the stream is down, the 30-second floor re-reads them; while it is
// up, nothing polls.

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { mount, settle } from './mount.tsx';

const FLOOR_MS = 30_000;

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

async function until(say: string, check: () => boolean, deadline: number): Promise<void> {
  if (check()) return;
  if (Date.now() > deadline) throw new Error(`never happened: ${say}`);
  await act(async () => {
    await pause();
  });
  return until(say, check, deadline);
}

/** The board's reads, the inbox reads, and a tab stream the case writes into, or refuses. */
function server(options: { readonly down?: boolean } = {}) {
  const asked = { board: 0, inbox: 0, count: 0 };
  const joins: string[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const fetch = ((url: string | URL) => {
    const at = String(url);
    if (at.includes('/live')) {
      joins.push(at);
      if (options.down === true) return Promise.resolve(new Response(null, { status: 503 }));
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    }
    if (at.endsWith('/inbox/read')) {
      asked.inbox += 1;
      return Promise.resolve(Response.json({ ok: true, inbox: [] }));
    }
    if (at.endsWith('/inbox/count')) {
      asked.count += 1;
      return Promise.resolve(Response.json({ ok: true, owed: 0 }));
    }
    if (at.endsWith('/task/board')) asked.board += 1;
    return Promise.resolve(Response.json({ ok: true, tasks: [] }));
  }) as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return {
    client,
    asked,
    joins,
    send(event: string, data = ''): void {
      stream?.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// eslint-disable-next-line max-lines-per-function -- one mounted screen, and the cases that share it
describe('INB-1f the board moves live on the page', () => {
  it('INB-1 board live (page): one stream per tab; an invalidate re-reads the board and an inbox signal the inbox and its count', async () => {
    const api = server();
    const view = await mount(<Projects client={api.client} grantKey="alpha:mia" />);
    const deadline = Date.now() + 2_000;
    await until('the tab joined', () => api.joins.length > 0, deadline);
    await until('the first reads', () => api.asked.board > 0 && api.asked.count > 0, deadline);
    await settle();
    // One stream for the tab: the board, the inbox list and its count share it.
    expect(api.joins).toHaveLength(1);
    expect(api.joins[0]).toMatch(/\/api\/b\/alpha\/live$/u);

    const before = { ...api.asked };
    api.send('invalidate', '22222222-2222-4222-8222-222222222222');
    await until('the board re-read', () => api.asked.board > before.board, deadline);

    const board = api.asked.board;
    api.send('inbox');
    await until(
      'the inbox and its count re-read',
      () => api.asked.inbox > before.inbox && api.asked.count > before.count,
      deadline,
    );
    // The inbox signal is the inbox's: the board is not asked again for it.
    await settle();
    expect(api.asked.board).toBe(board);
    expect(api.joins).toHaveLength(1);
    await view.unmount();
  });

  it('INB-1 the 30-second floor: the board and the owed count re-read every 30 seconds only while the channel is down', async () => {
    vi.useFakeTimers();
    const down = server({ down: true });
    const view = await mount(<Projects client={down.client} grantKey="alpha:mia" />);
    await vi.advanceTimersByTimeAsync(10);
    const first = { ...down.asked };
    expect(first.board).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(FLOOR_MS);
    expect(down.asked.board).toBeGreaterThan(first.board);
    expect(down.asked.count).toBeGreaterThan(first.count);
    await view.unmount();

    const up = server();
    const live = await mount(<Projects client={up.client} grantKey="alpha:mia" />);
    await vi.advanceTimersByTimeAsync(10);
    expect(up.joins).toHaveLength(1);
    const settled = { ...up.asked };
    await vi.advanceTimersByTimeAsync(FLOOR_MS * 3);
    expect(up.asked).toStrictEqual(settled);
    await live.unmount();
  });
});
