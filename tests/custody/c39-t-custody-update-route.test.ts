// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, custody's side of a login update: the login provider's admin route
// updates one user with a PUT on `/auth/v1/admin/users/<id>`. Custody sends a
// PUT only on a route its destination lists, and a PUT route is only ever one
// `/*` segment under a prefix, never an exact path (AW-13's routes, beside
// the trace store's DELETE and GET). Anything else is refused before a socket
// exists.

import { randomBytes } from 'node:crypto';
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
} from '../../packages/core-custody/src/index.ts';

const USERS = '/auth/v1/admin/users';
const USER_ID = '6f1c2a4e-0b7d-4c1e-9a3b-2d5e8f7a1c90';
const seen: (readonly [string, string])[] = [];
let server: Server;
let custody: Custody;
let folder: string;

const load = (path: string): ReturnType<typeof parseDestinations> =>
  parseDestinations([
    { key: 'users_target', origin: 'https://auth.example.com', routes: [{ method: 'PUT', path }] },
  ]);

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      seen.push([request.method ?? '', request.url ?? '']);
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  folder = mkdtempSync(join(tmpdir(), 'c39t-put-'));
  const credentialsFile = join(folder, 'credentials.json');
  const credential = {
    ref: 'users_key',
    kind: 'api_key',
    account: 'users-1',
    destination: 'users_target',
    header: 'authorization',
    value: `key-${randomBytes(18).toString('hex')}`,
  };
  writeFileSync(credentialsFile, JSON.stringify([credential]), { mode: 0o600 });
  const routes = [{ method: 'PUT', path: `${USERS}/*` }];
  custody = await startCustody({
    credentialsFile,
    destinations: [{ key: 'users_target', origin, routes } as Destination],
  });
}, 60_000);

afterAll(async () => {
  await custody?.stop();
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  rmSync(folder, { recursive: true, force: true });
});

const put = async (path: string): Promise<unknown> =>
  await custody.dispatch('users_key', {
    destination: 'users_target',
    path,
    method: 'PUT',
    body: '{}',
    timeoutMs: 2_000,
    maxResponseBytes: 4_096,
  });

it('C39-T custody update route: a PUT is listed only as one segment under a prefix, never an exact path', () => {
  expect(load(`${USERS}/*`)).toMatchObject({ ok: true });
  for (const path of [USERS, `${USERS}/${USER_ID}`, '/auth/*/users/*', '/*', `${USERS}/*/*`]) {
    expect(load(path), path).toMatchObject({ ok: false, code: 'DESTINATION_MALFORMED' });
  }
});

it('C39-T custody update route: a PUT goes only to one segment under its destination’s own PUT prefix', async () => {
  seen.length = 0;
  const refused = [
    `/auth/v1/admin/other/${USER_ID}`,
    `/auth/v1/admin/users2/${USER_ID}`,
    `${USERS}/${USER_ID}/factors`,
    USERS,
    `${USERS}/`,
    `${USERS}/..`,
  ];
  for (const path of refused) {
    // oxlint-disable-next-line no-await-in-loop
    expect(await put(path), path).toMatchObject({
      kind: 'refused',
      code: 'CUSTODY_REQUEST_MALFORMED',
    });
  }
  expect(seen).toHaveLength(0);
  expect(await put(`${USERS}/${USER_ID}`)).toMatchObject({
    kind: 'answered',
    outbound: { ok: true },
  });
  expect(seen).toStrictEqual([['PUT', `${USERS}/${USER_ID}`]]);
});
