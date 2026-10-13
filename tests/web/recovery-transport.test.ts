// SPDX-License-Identifier: AGPL-3.0-only
//
// The reset page's calls to the login provider (`session/recovery.ts`), over
// two real HTTP servers: the provider, and another origin it might send the
// browser to. No redirect is followed, so a password never reaches another
// origin, and only the provider's exact acknowledgement counts: a password
// write is set only when the answer names the session's own login, and a
// sign-out everywhere only on 204, tried again three times otherwise.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import {
  LOGOUT_RETRIES,
  setNewPassword,
  signOutEverywhere,
  verifyRecovery,
} from '../../apps/web/src/session/recovery.ts';

interface Heard {
  readonly route: string;
  readonly body: string;
}

type Answer = (request: IncomingMessage, response: ServerResponse, origins: Origins) => void;

interface Origins {
  readonly provider: string;
  readonly elsewhere: string;
}

const heard: { provider: Heard[]; elsewhere: Heard[] } = { provider: [], elsewhere: [] };
let answer: Answer = (_, response) => {
  response.writeHead(500).end();
};
let provider: Server;
let elsewhere: Server;
let origins: Origins;

function listen(into: keyof typeof heard, respond: () => Answer): Server {
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      heard[into].push({
        route: `${request.method ?? ''} ${request.url ?? ''}`,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      respond()(request, response, origins);
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

beforeAll(async () => {
  provider = listen('provider', () => answer);
  elsewhere = listen('elsewhere', () => json(200, { id: SUBJECT }));
  origins = { provider: await open(provider), elsewhere: await open(elsewhere) };
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

const SUBJECT = '0b9f6c1e-6a1d-4c39-9b1e-1f0c3a2d4e5f';
const PASSWORD = 'never-to-another-origin';
const route = () => ({ gotrueUrl: origins.provider, apiOrigin: '', fetch: globalThis.fetch });

it('sends no password to another origin when the write is answered with a redirect there', async () => {
  answer = (_, response, at) => {
    response.writeHead(307, { location: `${at.elsewhere}/user` }).end();
  };
  const outcome = await setNewPassword(route(), 'a-token', SUBJECT, PASSWORD);
  expect(outcome).not.toBe('set');
  expect(heard.provider.map((one) => one.route)).toStrictEqual(['PUT /user']);
  expect(heard.elsewhere).toStrictEqual([]);
});

it('takes a 200 write naming another login as not set', async () => {
  answer = json(200, { id: '7c1d2e3f-0000-4000-8000-000000000000' });
  expect(await setNewPassword(route(), 'a-token', SUBJECT, PASSWORD)).not.toBe('set');
  answer = json(200, { id: SUBJECT });
  expect(await setNewPassword(route(), 'a-token', SUBJECT, PASSWORD)).toBe('set');
});

it('takes a 422 write as a password to choose again', async () => {
  answer = json(422, { error_code: 'weak_password' });
  expect(await setNewPassword(route(), 'a-token', SUBJECT, PASSWORD)).toBe('refused');
});

it.each([
  ['a gateway answering 200', json(200, {})],
  ['a 503', json(503, {})],
])('takes %s to the sign-out as not signed out, and tries again three times', async (_, said) => {
  answer = said;
  expect(await signOutEverywhere(route(), 'a-token')).toBe(false);
  expect(heard.provider.map((one) => one.route)).toStrictEqual(
    Array.from({ length: 1 + LOGOUT_RETRIES }, () => 'POST /logout?scope=global'),
  );
  expect(LOGOUT_RETRIES).toBe(3);
});

it('takes a 204 to the sign-out as signed out, asked once', async () => {
  answer = (_, response) => {
    response.writeHead(204).end();
  };
  expect(await signOutEverywhere(route(), 'a-token')).toBe(true);
  expect(heard.provider).toHaveLength(1);
});

it('takes a verify only as 200 with a token and the login, and follows no redirect', async () => {
  answer = json(200, { access_token: 'a-token', user: { id: SUBJECT } });
  expect(await verifyRecovery(route(), 'a-hash')).toStrictEqual({
    accessToken: 'a-token',
    subject: SUBJECT,
  });
  answer = json(200, { access_token: 'a-token' });
  expect(await verifyRecovery(route(), 'a-hash')).toBeUndefined();
  answer = (_, response, at) => {
    response.writeHead(307, { location: `${at.elsewhere}/verify` }).end();
  };
  expect(await verifyRecovery(route(), 'a-hash')).toBeUndefined();
  expect(heard.elsewhere).toStrictEqual([]);
});
