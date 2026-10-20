// SPDX-License-Identifier: AGPL-3.0-only
//
// Two egress guards held at once, released in either order: while either is
// held every way out is refused and recorded once, by the guard taken last,
// and once both are released every swapped method is the one from before the
// first, the TCP handle's one turn later. A connect started under a guard on the socket method from before it
// is refused even when the guard is released before the connect reaches the
// handle. No database.

import dgram from 'node:dgram';
import dns from 'node:dns';
import { createServer, Socket, type Server } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { denyEgress, type EgressGuard } from './deny-egress.ts';

type Methods = Record<string, unknown>;

const TCP_HANDLE = (
  process as unknown as { binding(name: 'tcp_wrap'): { TCP: { prototype: Methods } } }
).binding('tcp_wrap').TCP.prototype;

/** Every method a guard swaps, as it is now. */
const swapped = (): Record<string, unknown> => ({
  socket: Socket.prototype.connect,
  handle: TCP_HANDLE['connect'],
  handle6: TCP_HANDLE['connect6'],
  lookup: dns.lookup,
  promisedLookup: dns.promises.lookup,
  resolve4: dns.resolve4,
  resolverResolve: dns.promises.Resolver.prototype.resolve,
  fetch: globalThis.fetch,
  udp: dgram.Socket.prototype.send,
});

const before = swapped();
/** Every swapped method once the release's turn is over: the handle's restore waits a turn. */
const afterTurn = async (): Promise<Record<string, unknown>> => {
  await new Promise<void>((turned) => {
    setImmediate(turned);
  });
  return swapped();
};
const retained = Socket.prototype.connect as (
  this: Socket,
  options: { host: string; port: number },
  listener: () => void,
) => Socket;

let server: Server;
let port = 0;
beforeAll(async () => {
  server = createServer((socket) => socket.end());
  await new Promise<void>((listening) => {
    server.listen(0, '127.0.0.1', listening);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP listener');
  port = address.port;
});
afterAll(async () => {
  await new Promise<void>((closed) => {
    server.close(() => closed());
  });
});

/** A connect through the socket method from before any guard: 'connected' or the refusal. */
const throughRetained = (): { readonly outcome: Promise<string> } => {
  const socket = new Socket();
  const outcome = new Promise<string>((settle) => {
    socket.once('error', (error) => settle(error.message));
    retained.call(socket, { host: '127.0.0.1', port }, () => {
      socket.destroy();
      settle('connected');
    });
  });
  return { outcome };
};

/** A connect through `net`'s own socket method as it is now. */
const throughNet = async (): Promise<string> =>
  await new Promise<string>((settle) => {
    const socket = new Socket();
    socket.once('error', (error) => settle(error.message));
    socket.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      settle('connected');
    });
  });

/** Releases whatever is still held, so a failed proof leaves no guard behind. */
const releasing = async (guards: EgressGuard[], proof: () => Promise<void>): Promise<void> => {
  try {
    await proof();
  } finally {
    for (const guard of guards.toReversed()) guard.release();
  }
};

it('two guards released last-taken first restore every method from before the first', async () => {
  const first = denyEgress();
  const second = denyEgress();
  await releasing([first, second], async () => {
    expect(await throughNet()).toMatch(/egress denied/u);
    second.release();
    first.release();
    expect(await afterTurn()).toEqual(before);
  });
});

it('two guards released first-taken first restore every method from before the first', async () => {
  const first = denyEgress();
  const second = denyEgress();
  await releasing([first, second], async () => {
    first.release();
    second.release();
    expect(await afterTurn()).toEqual(before);
    expect(await throughNet()).toBe('connected');
  });
});

it('the guard still held refuses and records a connect after the other is released', async () => {
  const first = denyEgress();
  const second = denyEgress();
  await releasing([first, second], async () => {
    first.release();
    expect(await throughNet()).toMatch(/egress denied/u);
    expect(await throughRetained().outcome).toMatch(/egress denied/u);
    expect([...first.attempts, ...second.attempts]).toEqual([`socket ${port}`, `socket ${port}`]);
  });
});

it('two guards held at once record each refused connect once, on the guard taken last', async () => {
  const first = denyEgress();
  const second = denyEgress();
  await releasing([first, second], async () => {
    expect(await throughNet()).toMatch(/egress denied/u);
    expect(await throughRetained().outcome).toMatch(/egress denied/u);
    expect(first.attempts).toEqual([]);
    expect(second.attempts).toEqual([`socket ${port}`, `socket ${port}`]);
  });
});

it('a guard released twice leaves a guard taken after it in place', async () => {
  const first = denyEgress();
  first.release();
  const second = denyEgress();
  await releasing([second], async () => {
    first.release();
    expect(await throughNet()).toMatch(/egress denied/u);
    expect(second.attempts).toEqual([`socket ${port}`]);
  });
  expect(await afterTurn()).toEqual(before);
});

it('a guard released after its test threw restores every method', async () => {
  const guard = denyEgress();
  await expect(
    releasing([guard], async () => {
      await Promise.resolve();
      throw new Error('the test body threw');
    }),
  ).rejects.toThrow('the test body threw');
  expect(await afterTurn()).toEqual(before);
  expect(await throughNet()).toBe('connected');
});

it('a connect started under the guard is refused and recorded though the guard is released before it reaches the handle', async () => {
  const guard = denyEgress();
  let started: { readonly outcome: Promise<string> } | undefined;
  await releasing([guard], async () => {
    started = throughRetained();
    guard.release();
    expect(await started.outcome).toMatch(/egress denied/u);
    expect(guard.attempts).toEqual([`socket ${port}`]);
  });
});
