// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable no-promise-executor-return -- the proof bodies are kept as written */
//
// The password update refuses a redirect: its body never reaches an origin other than the
// sign-in service's.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { setPassword } from '../../apps/web/src/session/password-grant.ts';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

it('a password update never sends its password to a redirected origin', async () => {
  const received: string[] = [];
  const other = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  const destination = await listen(other);
  const provider = createServer((_request, response) => {
    response.writeHead(307, { location: `${destination}/collect` });
    response.end();
  });
  const origin = await listen(provider);
  try {
    await setPassword({
      gotrueUrl: origin,
      token: 'synthetic-confirmation-token',
      password: 'synthetic-new-password',
      fetch: globalThis.fetch,
    });
    expect(received, 'No password body may leave the configured sign-in service origin').toEqual(
      [],
    );
  } finally {
    await close(provider);
    await close(other);
  }
});
