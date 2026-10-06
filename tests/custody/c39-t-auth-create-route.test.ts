// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, custody's side of a login made at accept: the login provider's
// destination carries its service key and takes no POST (`post: false`, C40
// security review M1), so the one POST the accept needs, `auth.create_user` on
// `/auth/v1/admin/users`, is a route the destination lists, by its exact path.
// A POST route is never a `/*` prefix. Every other POST to that destination,
// a sign-in link above all, is still refused before a socket exists, and the
// provider hears nothing.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  parseDestinations,
  startCustody,
  type Custody,
  type Destination,
  type OutboundRequest,
} from '../../packages/core-custody/src/index.ts';

const USERS = '/auth/v1/admin/users';
const seen: string[] = [];
let server: Server;
let custody: Custody;
let folder: string;

const load = (path: string): ReturnType<typeof parseDestinations> =>
  parseDestinations([
    {
      key: 'auth',
      origin: 'https://auth.example.com',
      post: false,
      routes: [{ method: 'POST', path }],
    },
  ]);

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      seen.push(`${request.method ?? ''} ${request.url ?? ''}`);
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  folder = mkdtempSync(join(tmpdir(), 'c39t-post-'));
});

afterAll(async () => {
  await custody?.stop();
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  rmSync(folder, { recursive: true, force: true });
});

/** Custody holding the login provider's key, its destination taking POST on the listed path alone. */
async function start(): Promise<Custody> {
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const credentialsFile = join(folder, 'credentials.json');
  const credential = {
    ref: 'auth_key',
    kind: 'api_key',
    account: 'auth-1',
    destination: 'auth',
    header: 'authorization',
    value: `canary-${randomBytes(18).toString('hex')}`,
  };
  writeFileSync(credentialsFile, JSON.stringify([credential]), { mode: 0o600 });
  const routes = [
    { method: 'POST', path: USERS },
    { method: 'PUT', path: `${USERS}/*` },
  ];
  return await startCustody({
    credentialsFile,
    destinations: [{ key: 'auth', origin, post: false, routes } as Destination],
  });
}

const post = async (path: string): Promise<unknown> =>
  await custody.dispatch('auth_key', {
    destination: 'auth',
    path,
    method: 'POST',
    body: '{}',
    timeoutMs: 2_000,
    maxResponseBytes: 4_096,
  });

it('C39-T custody create route: a POST is listed only by its exact path, never a prefix', () => {
  expect(load(USERS)).toMatchObject({ ok: true });
  for (const path of [`${USERS}/*`, '/*', '/auth/*/users', `${USERS}/`, 'auth/v1/admin/users']) {
    expect(load(path), path).toMatchObject({ ok: false, code: 'DESTINATION_MALFORMED' });
  }
  // A destination taking any POST lists none: the route would bar nothing.
  const open = {
    key: 'auth',
    origin: 'https://auth.example.com',
    routes: [{ method: 'POST', path: USERS }],
  };
  expect(parseDestinations([open])).toMatchObject({ ok: false, code: 'DESTINATION_MALFORMED' });
});

it('C39-T custody create route: a destination taking no POST takes one only on its listed path, nothing else sent', async () => {
  custody = await start();
  seen.length = 0;
  const refused = [
    '/auth/v1/admin/generate_link',
    '/auth/v1/admin/invite',
    `${USERS}/${randomUUID()}`,
    `${USERS}/`,
    `${USERS}2`,
    '/auth/v1/admin/USERS',
    `${USERS}/..`,
  ];
  for (const path of refused) {
    // oxlint-disable-next-line no-await-in-loop
    expect(await post(path), path).toMatchObject({
      kind: 'refused',
      code: 'CUSTODY_REQUEST_MALFORMED',
    });
  }
  expect(seen).toHaveLength(0);
  expect(await post(USERS)).toMatchObject({ kind: 'answered', outbound: { ok: true } });
  expect(seen).toStrictEqual([`POST ${USERS}`]);
});

it('C39-T custody deadline: a request names its notAfter in whole epoch ms; past it nothing is sent, before it the call is cut to it (SEC-P3A-6 L2)', async () => {
  custody = await start();
  seen.length = 0;
  const by = async (notAfter: unknown): Promise<unknown> =>
    await custody.dispatch('auth_key', {
      destination: 'auth',
      path: USERS,
      method: 'POST',
      body: '{}',
      timeoutMs: 10_000,
      maxResponseBytes: 4_096,
      notAfter,
    } as OutboundRequest);
  expect(await by(Date.now() - 1)).toMatchObject({
    kind: 'answered',
    outbound: { ok: false, fault: 'timeout' },
  });
  expect(seen).toHaveLength(0);
  expect(await by(Date.now() + 5_000)).toMatchObject({ kind: 'answered', outbound: { ok: true } });
  expect(seen).toStrictEqual([`POST ${USERS}`]);
  // Not a whole number of ms: refused whole, as any request outside the grammar is.
  for (const notAfter of [Date.now() + 5_000.5, String(Date.now() + 5_000), true]) {
    // oxlint-disable-next-line no-await-in-loop
    expect(await by(notAfter), String(notAfter)).toMatchObject({
      kind: 'refused',
      code: 'CUSTODY_REQUEST_MALFORMED',
    });
  }
  expect(seen).toHaveLength(1);
});
