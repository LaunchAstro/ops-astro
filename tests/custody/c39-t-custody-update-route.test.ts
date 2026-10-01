// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, custody's side of a login create: the login provider's admin route
// makes a user with a POST on `/auth/v1/admin/users`, and would update one
// with a PUT on `/auth/v1/admin/users/<id>`. Custody never sends a PUT: no
// destination may list a PUT route, and a PUT on any path, the one user's
// among them, is refused before a socket exists (AW-13's routes, beside the
// trace store's DELETE and GET). A destination that lists POST paths takes a
// POST on those exact paths alone.

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

const load = (path: unknown, method = 'PUT'): ReturnType<typeof parseDestinations> =>
  parseDestinations([
    { key: 'users_target', origin: 'https://auth.example.com', routes: [{ method, path }] },
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
  const routes = [{ method: 'POST', path: USERS }];
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

const put = async (path: string, method = 'PUT'): Promise<unknown> =>
  await custody.dispatch('users_key', {
    destination: 'users_target',
    path,
    method: method as 'POST',
    body: '{}',
    timeoutMs: 2_000,
    maxResponseBytes: 4_096,
  });

it('C39-T custody update route: a PUT is never listed, as one segment under a prefix or an exact path', () => {
  for (const path of [
    `${USERS}/*`,
    USERS,
    `${USERS}/${USER_ID}`,
    '/auth/*/users/*',
    '/*',
    `${USERS}/*/*`,
  ]) {
    expect(load(path), path).toMatchObject({ ok: false, code: 'DESTINATION_MALFORMED' });
  }
});

it('C39-T custody update route: custody sends no PUT, not even on the one user’s path under the login provider’s create', async () => {
  seen.length = 0;
  const refused = [
    `${USERS}/${USER_ID}`,
    `/auth/v1/admin/other/${USER_ID}`,
    `/auth/v1/admin/users2/${USER_ID}`,
    `${USERS}/${USER_ID}/factors`,
    USERS,
    `${USERS}/`,
    `${USERS}/..`,
    `${USERS}/${USER_ID}%2Ffactors`,
    `${USERS}/${USER_ID}?next=x`,
    `${USERS}//${USER_ID}`,
  ];
  for (const path of refused) {
    // oxlint-disable-next-line no-await-in-loop
    expect(await put(path), path).toMatchObject({
      kind: 'refused',
      code: 'CUSTODY_REQUEST_MALFORMED',
    });
  }
  expect(seen).toHaveLength(0);
});

it('C39-T custody create route: a POST is listed only as an exact plain path', () => {
  expect(load(USERS, 'POST')).toMatchObject({ ok: true });
  const malformed: unknown[] = [
    `${USERS}/*`,
    `${USERS}/`,
    'auth/v1/admin/users',
    '/auth/v1/../users',
    '//evil.example.com/x',
    '/auth/v1/admin%2Fusers',
    `${USERS}?next=x`,
    '',
    7,
  ];
  for (const path of malformed) {
    expect(load(path, 'POST'), String(path)).toMatchObject({
      ok: false,
      code: 'DESTINATION_MALFORMED',
    });
  }
});

it('C39-T custody create route: a destination that lists its POST paths takes a POST on those exact paths and no other', async () => {
  seen.length = 0;
  const refused = [
    '/auth/v1/admin/generate_link',
    '/auth/v1/invite',
    '/auth/v1/otp',
    `${USERS}/${USER_ID}/factors`,
    `${USERS}/${USER_ID}`,
    `${USERS}/`,
    '/auth/v1/admin/Users',
    '/auth/v1//admin/users',
    '/auth/v1/admin%2Fusers',
    `${USERS}?next=x`,
    `/${USERS}`,
  ];
  for (const path of refused) {
    // oxlint-disable-next-line no-await-in-loop
    expect(await put(path, 'POST'), path).toMatchObject({
      kind: 'answered',
      outbound: { ok: false, fault: 'bad_path' },
    });
  }
  expect(seen).toHaveLength(0);
  expect(await put(USERS, 'POST')).toMatchObject({ kind: 'answered', outbound: { ok: true } });
  expect(seen).toStrictEqual([['POST', USERS]]);
});
