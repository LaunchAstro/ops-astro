// SPDX-License-Identifier: AGPL-3.0-only
//
// The API's calls to the login provider's `/user` on a person's own bearer
// (`apps/api/auth/provider-user.ts`), over two real HTTP servers: the
// provider, and another origin it might redirect to. No redirect is followed,
// so a password never reaches another origin, and a session is `gone` only on
// GoTrue's own `session_not_found`, never on a gateway's refusal.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { askUser, sessionLive } from '../../apps/api/auth/provider-user.ts';

type Answer = (request: IncomingMessage, response: ServerResponse) => void;

const heard: { provider: string[]; elsewhere: string[] } = { provider: [], elsewhere: [] };
let answer: Answer = (_, response) => {
  response.writeHead(500).end();
};
let provider: Server;
let elsewhere: Server;
let at: { provider: string; elsewhere: string };

function listen(into: keyof typeof heard, respond: () => Answer): Server {
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      heard[into].push(`${request.method ?? ''} ${request.url ?? ''} ${Buffer.concat(chunks)}`);
      respond()(request, response);
    });
  });
}

const json = (status: number, body: unknown): Answer => {
  return (_, response) => {
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
};

async function open(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

const SUBJECT = '0b9f6c1e-6a1d-4c39-9b1e-1f0c3a2d4e5f';
const PASSWORD = 'never-to-another-origin';

beforeAll(async () => {
  provider = listen('provider', () => answer);
  elsewhere = listen('elsewhere', () => json(200, { id: SUBJECT }));
  at = { provider: await open(provider), elsewhere: await open(elsewhere) };
});

afterEach(() => {
  heard.provider = [];
  heard.elsewhere = [];
});

afterAll(async () => {
  for (const server of [provider, elsewhere]) {
    server.closeAllConnections();
    // oxlint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

const options = () => ({ issuer: at.provider, providerKey: 'a-publishable-key' });

it('writes no password to another origin when the write is answered with a redirect there', async () => {
  answer = (_, response) => {
    response.writeHead(307, { location: `${at.elsewhere}/user` }).end();
  };
  expect(await askUser(options(), 'a-token', { password: PASSWORD })).toBe('unreachable');
  expect(heard.provider).toStrictEqual([`PUT /user ${JSON.stringify({ password: PASSWORD })}`]);
  expect(heard.elsewhere).toStrictEqual([]);
});

it('takes a session as gone only on the provider saying it has none', async () => {
  answer = json(403, { error_code: 'session_not_found' });
  expect(await sessionLive(options(), 'a-token', SUBJECT)).toBe('gone');
  answer = json(401, { error_code: 'no_authorization' });
  expect(await sessionLive(options(), 'a-token', SUBJECT)).toBe('unknown');
  answer = json(403, {});
  expect(await sessionLive(options(), 'a-token', SUBJECT)).toBe('unknown');
  answer = (_, response) => {
    response.writeHead(307, { location: `${at.elsewhere}/user` }).end();
  };
  expect(await sessionLive(options(), 'a-token', SUBJECT)).toBe('unknown');
  expect(heard.elsewhere).toStrictEqual([]);
});

it('takes a session as live only on a 200 naming its login', async () => {
  answer = json(200, { id: '7c1d2e3f-0000-4000-8000-000000000000' });
  expect(await sessionLive(options(), 'a-token', SUBJECT)).toBe('unknown');
  answer = json(200, { id: SUBJECT });
  expect(await sessionLive(options(), 'a-token', SUBJECT)).toBe('live');
  expect(heard.provider).toStrictEqual(['GET /user ', 'GET /user ']);
});
