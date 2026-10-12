// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http';
import { expect, it } from 'vitest';
import { signIn } from '../../apps/web/src/session/password-grant.ts';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing test address');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

it('a password grant does not forward credentials to a redirected origin', async () => {
  const received: string[] = [];
  const foreign = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push(Buffer.concat(chunks).toString('utf8'));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ access_token: 'foreign-answer' }));
  });
  const destination = await listen(foreign);
  const provider = createServer((_request, response) => {
    response.writeHead(307, { location: `${destination}/collect` });
    response.end();
  });
  try {
    const gotrueUrl = await listen(provider);
    const answer = await signIn({
      gotrueUrl,
      email: 'sol-proof@example.invalid',
      password: 'synthetic-proof-password',
      fetch: globalThis.fetch,
    });
    expect(received).toEqual([]);
    expect(answer).toMatchObject({ ok: false });
  } finally {
    await Promise.all([close(provider), close(foreign)]);
  }
});
