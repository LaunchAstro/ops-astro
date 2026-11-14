// SPDX-License-Identifier: AGPL-3.0-only
//
// Signing in again whose tab moved on meanwhile signs the new provider
// session out with its own bearer token (`signOutAtProvider`). That POST
// follows no redirect (#1356): a 307 from the provider's logout never resends
// the token to another origin. Two real HTTP servers on loopback.

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { expect, it } from 'vitest';
import { signInAgainSession } from '../../apps/web/src/session/sign-in-again.ts';

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

it("a sign-in again dropped before its trade sends the new session's token to no redirected origin", async () => {
  const received: IncomingHttpHeaders[] = [];
  const foreign = createServer((request, response) => {
    received.push(request.headers);
    response.writeHead(204);
    response.end();
  });
  const destination = await listen(foreign);
  const asked: string[] = [];
  const provider = createServer((request, response) => {
    asked.push(`${request.method ?? ''} ${request.url ?? ''}`);
    if ((request.url ?? '').startsWith('/token')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ access_token: 'synthetic-new-session-token' }));
      return;
    }
    response.writeHead(307, { location: `${destination}/collect` });
    response.end();
  });
  try {
    const gotrueUrl = await listen(provider);
    const answer = await signInAgainSession({
      gotrueUrl,
      email: 'sol-proof@example.invalid',
      password: 'synthetic-proof-password',
      route: { apiOrigin: 'http://127.0.0.1:9', fetch: globalThis.fetch },
      businessKey: 'alpha',
      from: undefined,
      current: () => false,
      adopt: () => undefined,
    });
    expect(answer).toMatchObject({ ok: false });
    expect(asked).toEqual(['POST /token?grant_type=password', 'POST /logout?scope=local']);
    expect(received, 'the redirected origin receives nothing').toEqual([]);
  } finally {
    await Promise.all([close(provider), close(foreign)]);
  }
});
