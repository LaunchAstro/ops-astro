// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { insertActor, insertBusiness, insertLogin, insertPerson } from '../identity/fixture.ts';

function runEndings(
  settings: Readonly<Record<string, string>>,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['apps/endings/main.ts', '--once'], {
      cwd: process.cwd(),
      env: { ...process.env, ...settings },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      err += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, out, err }));
  });
}

it('malformed database settings never print their password', async () => {
  const canary = 'SOL-OW070-DATABASE-PASSWORD-CANARY';
  const settings = ['DATABASE_ADMIN_URL', 'DATABASE_URL'];
  const results = await Promise.all(
    settings.map(async (setting) => {
      const result = await runEndings({
        DATABASE_ADMIN_URL: 'postgres://owner@127.0.0.1:1/none',
        DATABASE_URL: 'postgres://app@127.0.0.1:1/none',
        GOTRUE_URL: 'https://auth.example.test/auth/v1',
        SUPABASE_SERVICE_KEY: 'SOL-OW070-SYNTHETIC-SERVICE-KEY',
        [setting]: `postgres://owner:${canary}@127.0.0.1:invalid/none`,
      });
      expect(result.code, 'invalid configuration must fail').not.toBe(0);
      return (result.out + result.err).includes(canary) ? setting : undefined;
    }),
  );
  const exposed = results.filter((setting) => setting !== undefined);
  expect(exposed, 'database settings exposed their password').toEqual([]);
});

describe.skipIf(databaseUrlFromEnvironment() === undefined)('endings --once and a provider failure', () => {
  let db: FreshDatabase;
  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'sol_ow070' });
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('endings --once exits 1 when a provider failure leaves a step owed', async () => {
    const business = await insertBusiness(db.app, 'sol-ow070');
    await db.app.withBusiness(business, async (tx) => {
      const person = await insertPerson(tx, 'Sol synthetic person');
      const actor = await insertActor(tx, person);
      const login = await insertLogin(tx, randomUUID());
      await tx.query(
        'insert into public.access_endings (business_id, person_id, login_id, ended_by_actor_id) values ($1, $2, $3, $4)',
        [business, person, login, actor],
      );
    });
    let calls = 0;
    const provider = createServer((_request, response) => {
      calls += 1;
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{}');
    });
    await new Promise<void>((resolve) => {
      provider.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = provider.address();
      if (address === null || typeof address === 'string') throw new Error('no provider address');
      const serverUrl = databaseUrlFromEnvironment();
      if (serverUrl === undefined) throw new Error('no test database');
      const ownerUrl = new URL(serverUrl);
      ownerUrl.pathname = `/${db.name}`;
      const result = await runEndings({
        DATABASE_ADMIN_URL: ownerUrl.toString(),
        DATABASE_URL: db.appUrl,
        GOTRUE_URL: `http://127.0.0.1:${address.port}/auth/v1`,
        SUPABASE_SERVICE_KEY: 'SOL-OW070-SYNTHETIC-SERVICE-KEY',
      });
      expect(calls, 'the real provider adapter reached the failing provider').toBeGreaterThan(0);
      const rows = await db.admin.execute<{ last_fault: string; owed: boolean }>(
        'select last_fault, sessions_ended_at is null as owed from public.access_endings',
      );
      expect(rows).toEqual([expect.objectContaining({ owed: true })]);
      expect(result.code, 'a failed provider pass must fail the scheduler job').toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        provider.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
