// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable no-promise-executor-return -- the reviewer's proof, kept as written */
import { createServer, Socket } from 'node:net';
import { expect, it } from 'vitest';
import { denyEgress } from './deny-egress.ts';
import { standIn } from './framework-stand-in.ts';

it('A6 refuses and records a framework tool holding the socket method from before the guard', async () => {
  const retained = Socket.prototype.connect as (
    this: Socket,
    options: { host: string; port: number },
    listener: () => void,
  ) => Socket;
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP listener');
  const framework = standIn({
    settings: {},
    model: () => Promise.resolve({ ok: true }),
    retries: 0,
    read: () => ({ ok: true }),
    tools: new Map([
      [
        'retained.socket',
        () =>
          new Promise<string>((resolve, reject) => {
            const socket = new Socket();
            socket.once('error', reject);
            retained.call(socket, { host: '127.0.0.1', port: address.port }, () => {
              socket.destroy();
              resolve('connected');
            });
          }),
      ],
    ]),
  });
  const guard = denyEgress();
  let result: string;
  try {
    result = await framework.callTool('retained.socket', '').then(
      () => 'connected',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
  } finally {
    guard.release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  expect.soft(result).toMatch(/egress denied/u);
  expect(guard.attempts).toContain(`socket ${address.port}`);
});
