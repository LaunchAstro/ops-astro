// SPDX-License-Identifier: AGPL-3.0-only
//
// C40 security review M1 (SEC37): the login provider's destination carries
// its service key, so custody sends it only the routes it lists. A POST to
// any other admin path (a sign-in link, a new user) is refused by custody
// before a socket exists, and the provider hears nothing.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startCustody, type Custody } from '../../packages/core-custody/src/index.ts';

const seen: string[] = [];
/** One user the listed PUT route names. */
const user = randomUUID();
let server: Server;
let custody: Custody;
let folder: string;

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
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  folder = mkdtempSync(join(tmpdir(), 'c40-auth-routes-'));
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
  custody = await startCustody({
    credentialsFile,
    destinations: [
      {
        key: 'auth',
        origin,
        post: false,
        routes: [{ method: 'PUT', path: '/auth/v1/admin/users/*' }],
      },
    ],
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

const asked = (method: 'POST' | 'PUT', path: string, body: string) => ({
  destination: 'auth',
  method,
  path,
  body,
  timeoutMs: 2_000,
  maxResponseBytes: 4_096,
});

it('C40 M1 a POST to /auth/v1/admin/generate_link through the service-key destination is refused by custody, nothing sent', async () => {
  const link = await custody.dispatch(
    'auth_key',
    asked('POST', '/auth/v1/admin/generate_link', '{"type":"magiclink","email":"x@example.test"}'),
  );
  expect(link).toMatchObject({ kind: 'refused', code: 'CUSTODY_REQUEST_MALFORMED' });
  expect(seen).toEqual([]);
  // The route the destination lists still goes through.
  const listed = await custody.dispatch(
    'auth_key',
    asked('PUT', `/auth/v1/admin/users/${user}`, '{"password":"a long new password"}'),
  );
  expect(listed).toMatchObject({ kind: 'answered', outbound: { ok: true } });
  expect(seen).toEqual([`PUT /auth/v1/admin/users/${user}`]);
});
