// SPDX-License-Identifier: AGPL-3.0-only
//
// FIX-2B1 review RS, proof 1: a tab that leaves while the live route still
// awaits its door (`asks.atDoor`, `mayJoinBoard`: a database transaction each),
// before `streamSSE` has built the stream, leaves a `follow` that never ends.
//
// Hono 4.13.9 aborts the SSE stream only when the response body is cancelled,
// and @hono/node-server cancels it only on the response's `close` event. A
// socket that closed before the handler returned has already emitted `close`,
// so the listener node-server adds when it starts writing is never called;
// its first write to the destroyed response returns false and it waits for a
// `drain` that never comes. The stream never reads as aborted, so the fix's
// `if (stream.aborted)` is not reached and `onAbort` never fires: `follow`
// seats the person, subscribes, and stays until restart (REVIEW-MAIN-2B1-6's
// consequence, by an earlier window). The control case leaves after the
// stream has started and ends, so the harness does see an end.
//
// Real node-server, real Hono stream, real `follow`; the door is a gate.

import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { describe, expect, it } from 'vitest';
import type { Listener } from '../../packages/core-records/src/index.ts';
import { endsWithRequest, follow, type Watching } from '../../apps/api/live-follow.ts';
import { createLivePresence } from '../../apps/api/live-presence.ts';
import { startLiveTopics, type LiveTopics } from '../../apps/api/live.ts';

const business = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const person = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const task = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BOUND_MS = 1_500;

async function topicsNow(): Promise<LiveTopics> {
  const listener = {
    listen: (_channel: string, _payload: unknown, onListening: () => void) => {
      onListening();
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  } as unknown as Listener;
  return await startLiveTopics(listener);
}

const asks: Watching = {
  businessId: business,
  atDoor: (taskIds) => Promise.resolve(taskIds.map(() => task)),
  again: () => Promise.resolve(task),
};

async function bounded(running: Promise<unknown>): Promise<'resolved' | 'hung'> {
  return await Promise.race([
    running.then(() => 'resolved' as const),
    setTimeout(BOUND_MS, 'hung' as const),
  ]);
}

// oxlint-disable-next-line max-lines-per-function -- one harness, two cases
describe('FIX-2B1 RS proof 1: a tab that leaves before the stream is built', () => {
  it.each([
    ['while the route awaits its door, before streamSSE', 'door'],
    ['after the stream started (control)', 'stream'],
  ] as const)(
    'FIX-2B1-RS-1: a tab that leaves %s ends its follow and frees its presence seat',
    // oxlint-disable-next-line max-lines-per-function -- one harness, two cases
    async (_when, leaves) => {
      const topics = await topicsNow();
      const presence = createLivePresence();
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- replaced by the resolver below
      let entered = (): void => {};
      const inDoor = new Promise<void>((resolve) => {
        entered = resolve;
      });
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- replaced by the resolver below
      let open = (): void => {};
      const doorOpens = new Promise<void>((resolve) => {
        open = resolve;
      });
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- replaced by the resolver below
      let started = (): void => {};
      const following = new Promise<void>((resolve) => {
        started = resolve;
      });
      let running: Promise<void> | undefined;
      const session = {
        sessionId: 'seat-1',
        personId: person,
        name: 'Ana',
        side: 'staff' as const,
      };

      const app = new Hono();
      app.get('/live', async (context) => {
        entered();
        // oxlint-disable-next-line no-inline-comments -- the reviewer's note on the step
        await doorOpens; // as app.ts awaits asks.atDoor / mayJoinBoard
        return streamSSE(context, async (stream) => {
          // As each streamSSE callback in app.ts does first (lead ruling, FIX-2B1).
          endsWithRequest(stream, context.req.raw.signal);
          running = follow(
            stream,
            { topics, recheckMs: 60_000 },
            [{ label: `task:${task}`, taskId: task }],
            asks,
            { session, presence },
          );
          started();
          await running;
        });
      });
      const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
      await once(server, 'listening');
      const { port } = server.address() as AddressInfo;
      const socket = connect(port, '127.0.0.1');
      await once(socket, 'connect');
      socket.on('error', () => {});
      socket.write('GET /live HTTP/1.1\r\nHost: localhost\r\nAccept: text/event-stream\r\n\r\n');
      await inDoor;
      if (leaves === 'door') {
        socket.destroy();
        // oxlint-disable-next-line no-inline-comments -- the reviewer's note on the step
        await setTimeout(150); // the server sees the socket close
        open();
        await following;
      } else {
        open();
        await following;
        await once(socket, 'data');
        socket.destroy();
      }
      if (running === undefined) throw new Error('follow never started');
      try {
        expect.soft(await bounded(running), 'follow ends once its tab has left').toBe('resolved');
        expect.soft(presence.held, 'the presence book holds no seat for the tab that left').toBe(0);
      } finally {
        await bounded(topics.close());
        server.close();
      }
    },
    15_000,
  );
});
