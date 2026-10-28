// SPDX-License-Identifier: AGPL-3.0-only
//
// A TCP relay in front of Postgres, for the proofs that a cancel request the
// server has not taken in time cannot touch a later statement (#2240, Sol's
// S2243-3 and S2243-4). postgres.js sends a cancel request on a connection of
// its own, a 16-byte packet with the CancelRequest code. The relay passes
// every other connection straight through, and holds a cancel request back
// `LATE_MS` (`late`) or never delivers it (`lost`).

import { once } from 'node:events';
import { createConnection, createServer, type Socket } from 'node:net';

/** The protocol's CancelRequest code (1234 in the high half, 5678 in the low). */
const CANCEL_REQUEST_CODE = 80_877_102;

/** How long `late` holds a cancel request back: past the driver's wait for it. */
export const LATE_MS = 900;

export interface CancelRelay {
  /** The URL given, its host and port the relay's. */
  readonly url: string;
  /** The cancel requests that reached the relay. */
  readonly cancels: () => number;
  /** The cancel requests the relay passed on to the server. */
  readonly delivered: () => number;
  readonly end: () => Promise<void>;
}

/** `client`'s connection, its first bytes `first`, passed on to `remote` and back. */
function passOn(client: Socket, first: Buffer, remote: { host: string; port: number }): Socket {
  const upstream = createConnection(remote);
  upstream.on('error', () => client.destroy());
  upstream.once('connect', () => {
    upstream.write(first);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  upstream.on('close', () => client.end());
  client.on('close', () => upstream.destroy());
  return upstream;
}

export async function cancelRelay(url: string, mode: 'late' | 'lost'): Promise<CancelRelay> {
  const target = new URL(url);
  const remote = { host: target.hostname, port: Number(target.port || '5432') };
  const sockets = new Set<Socket>();
  const timers: NodeJS.Timeout[] = [];
  let cancels = 0;
  let delivered = 0;
  const forward = (client: Socket, first: Buffer): void => {
    if (!client.destroyed) sockets.add(passOn(client, first, remote));
  };
  const server = createServer((client) => {
    sockets.add(client);
    client.on('error', () => {});
    client.once('data', (first: Buffer) => {
      client.pause();
      if (first.length !== 16 || first.readInt32BE(4) !== CANCEL_REQUEST_CODE) {
        forward(client, first);
        return;
      }
      cancels += 1;
      if (mode === 'lost') return;
      timers.push(
        setTimeout(() => {
          delivered += 1;
          forward(client, first);
        }, LATE_MS),
      );
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the relay has no port');
  target.hostname = '127.0.0.1';
  target.port = String(address.port);
  return {
    url: target.toString(),
    cancels: () => cancels,
    delivered: () => delivered,
    end: async () => {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

/** What the process raised with nothing to catch it while `work` ran. */
export async function uncaughtDuring(work: () => Promise<void>): Promise<readonly unknown[]> {
  const raised: unknown[] = [];
  const keep = (cause: unknown): void => {
    raised.push(cause);
  };
  process.on('uncaughtException', keep);
  process.on('unhandledRejection', keep);
  try {
    await work();
  } finally {
    process.off('uncaughtException', keep);
    process.off('unhandledRejection', keep);
  }
  return raised;
}
