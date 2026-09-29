// SPDX-License-Identifier: AGPL-3.0-only
//
// `T2 identity local` over a composed API with a real ledger: the
// served-identity route answers on loopback only (T2b, spike RN-03). Moved out
// of `t2b-worker.test.ts` whole, to keep that suite under the per-file cap.

import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { readMigrations } from '../../packages/core-records/src/tenancy/migrate.ts';
import { migrationHead, readIdentity } from '../../apps/api/identity.ts';
import { createApiFixture, type ApiFixture } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
const ROOT = resolve(import.meta.dirname, '../..');

if (serverUrl === undefined) {
  console.warn(
    'api/t2b-identity: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

describe.skipIf(serverUrl === undefined)('T2 identity local: the served-identity route', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let server: ServerType;
  let origin: string;

  beforeAll(async () => {
    fixture = await createApiFixture('t2bid');
    api = fixture.compose(undefined, readIdentity(ROOT));
    server = serve({ fetch: api.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise<void>((done) => {
      server.once('listening', () => done());
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((done) => {
      if (server === undefined) done();
      else server.close(() => done());
    });
    await fixture?.drop();
  });

  const get = async (env?: object) =>
    await api.fetch(new Request('http://api.test/api/identity'), env);

  it('answers loopback with the process, the tree and the ledger’s migration head', async () => {
    const response = await get({ incoming: { socket: { remoteAddress: '127.0.0.1' } } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    const here = readIdentity(ROOT);
    expect(body).toMatchObject({ pid: process.pid, checkout: ROOT, tree: here.tree });
    expect(body['migrationHead']).toBe(migrationHead(readMigrations(join(ROOT, 'migrations'))));
  });

  it('answers a real loopback socket through the node server', async () => {
    const response = await fetch(`${origin}/api/identity`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { pid: number }).pid).toBe(process.pid);
  });

  it('refuses anything that is not loopback, and an unknown peer', async () => {
    const answers = await Promise.all(
      [{ incoming: { socket: { remoteAddress: '10.0.0.2' } } }, undefined].map(get),
    );
    for (const response of answers) expect(response.status).toBe(404);
    const texts = await Promise.all(answers.map(async (response) => await response.text()));
    for (const text of texts) expect(text).not.toContain(ROOT);
  });
});
