// SPDX-License-Identifier: AGPL-3.0-only
//
// The staging worker went dead an hour after it started: its one bearer
// expired and every pass after that was refused `AUTH_SESSION_EXPIRED`
// (11 October 2026). Here the worker runs as its own process against a served
// API over a real database, signing in at a stand-in sign-in service whose
// tokens really expire after a few seconds while it claims an hour, so the
// worker cannot renew ahead and meets the API's own `AUTH_SESSION_EXPIRED`
// again and again. Each time it signs in again and asks the same call once
// more, and its passes keep being answered long after the first token died.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readIdentity } from '../../apps/api/identity.ts';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { SIGN_IN_SETTINGS, standInGoTrue, type StandIn } from '../support/stand-in-gotrue.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type ApiFixture,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
const ROOT = resolve(import.meta.dirname, '../..');
const LIFE_SECONDS = 3;
const RUN_MS = 14_000;

if (serverUrl === undefined) {
  console.warn('api/worker-renews-sign-in: DATABASE_URL is unset, so nothing below ran.');
}

let fixture: ApiFixture;
let server: ServerType;
let gotrue: StandIn;
let origin = '';
let delegation = '';
const issued: string[] = [];

beforeAll(async () => {
  if (serverUrl === undefined) return;
  fixture = await createApiFixture('worker_renews');
  const api = fixture.compose(undefined, readIdentity(ROOT));
  const person = await tokenFor(fixture.member.presented.subject);
  const created = await post(
    api,
    `/api/b/${BUSINESS_KEY}${pathOf('task.create')}`,
    { operationId: randomUUID(), fields: { title: 'the task the worker proposes on' } },
    authorised(person),
  );
  const taskId = String(created.body['recordId']);
  delegation = await fixture.db.app.withBusiness(fixture.business, async (tx) => {
    const minted = await mintDelegation(tx, {
      agentActorId: fixture.agentActorId,
      delegatePersonId: fixture.member.personId,
      mintedByActorId: fixture.member.actorId,
      purpose: 'renewal',
      collections: ['task'],
      actions: ['read', 'comment', 'write'],
      purposeScope: { kind: 'record', id: taskId },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
    return minted.value.credential;
  });
  gotrue = await standInGoTrue({
    issue: async () => {
      issued.push(await tokenFor(fixture.agent.subject, { expiresIn: LIFE_SECONDS }));
      return issued.at(-1) as string;
    },
    expiresIn: 3_600,
  });
  server = serve({ fetch: api.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>((done) => {
    server.once('listening', () => done());
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await gotrue?.close();
  await new Promise<void>((done) => {
    if (server === undefined) done();
    else server.close(() => done());
  });
  await fixture?.drop();
});

it.skipIf(serverUrl === undefined)(
  'a worker whose bearer keeps expiring signs in again and keeps being answered',
  async () => {
    const child = spawn(process.execPath, [resolve(ROOT, 'apps/worker/main.ts')], {
      env: {
        PATH: process.env['PATH'] ?? '',
        OPS_ASTRO_API_URL: origin,
        OPS_ASTRO_BUSINESS: BUSINESS_KEY,
        ...SIGN_IN_SETTINGS,
        OPS_ASTRO_GOTRUE_URL: gotrue.url,
        OPS_ASTRO_DELEGATION: delegation,
        OPS_ASTRO_WORKER_INTERVAL_MS: '250',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const exited = new Promise<number | null>((done) => {
      child.on('close', done);
    });
    await new Promise((done) => {
      setTimeout(done, RUN_MS);
    });
    child.kill('SIGTERM');
    await exited;

    const outcomes = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(stderr).toBe('');
    expect(Object.keys(outcomes[0] ?? {})).toEqual(['proposed']);
    // Polling for a person's approval, every pass answered, never refused.
    expect(outcomes.slice(1).every((outcome) => 'idle' in outcome)).toBe(true);
    // Answered passes well past the first bearer's death, through several renewals.
    expect(outcomes.length).toBeGreaterThan(20);
    expect(gotrue.signIns()).toBeGreaterThanOrEqual(RUN_MS / 1_000 / LIFE_SECONDS - 1);
    for (const secret of [...issued, delegation, SIGN_IN_SETTINGS.OPS_ASTRO_PASSWORD]) {
      expect(`${stdout}${stderr}`.includes(secret), 'a credential was printed').toBe(false);
    }
  },
  60_000,
);
