// SPDX-License-Identifier: AGPL-3.0-only
// S0-1a: staging's database holds made-up data only, so the seed refuses a
// database that carries anything a production backup would bring: a business
// the seed does not make, or a sign-in address that is not a made-up one. The
// refusal comes before the seed writes a row or a file, and it names counts,
// never the rows it found.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { productionSigns } from '../../scripts/ops/made-up-only.ts';

const serverUrl = databaseUrlFromEnvironment();
const SEED = new URL('../../scripts/local-seed.mjs', import.meta.url).pathname;
const USERS_FILE = new URL('../../.local/synthetic-users.json', import.meta.url).pathname;
const MADE_UP = ['alpha', 'bravo'];

if (serverUrl === undefined) {
  console.warn('S0-1 no production data: DATABASE_URL is unset, so nothing below ran.');
}

describe.skipIf(serverUrl === undefined)('S0-1 no production data', () => {
  let db: FreshDatabase;
  let adminUrl: string;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 's01a' });
    const url = new URL(serverUrl!);
    url.pathname = `/${db.name}`;
    adminUrl = url.toString();
    await db.admin.execute('create schema if not exists auth');
    await db.admin.execute('create table if not exists auth.users (id uuid, email text)');
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  const reset = async (): Promise<void> => {
    await db.admin.execute('delete from public.businesses');
    await db.admin.execute('delete from auth.users');
  };
  const business = (key: string): Promise<unknown> =>
    db.admin.execute(
      'insert into public.businesses (business_id, id, key, name) values ($1, $1, $2, $3)',
      [randomUUID(), key, `${key} Pty Ltd`],
    );
  const address = (email: string): Promise<unknown> =>
    db.admin.execute('insert into auth.users (id, email) values ($1, $2)', [randomUUID(), email]);
  const seed = () => {
    const usersFileBefore = existsSync(USERS_FILE);
    const result = spawnSync(process.execPath, [SEED], {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_ADMIN_URL: adminUrl, DATABASE_URL: db.appUrl },
    });
    expect(existsSync(USERS_FILE), 'the refused seed wrote its users file').toBe(usersFileBefore);
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  };
  const keys = async (): Promise<string[]> =>
    (await db.admin.execute<{ key: string }>('select key from public.businesses order by key')).map(
      (row) => row.key,
    );

  it('S0-1 no production data: a business the seed does not make is refused before any write', async () => {
    await reset();
    await business('harbour-freight-canary');
    const result = seed();
    expect(result.status, result.out).toBe(1);
    expect(result.out).toMatch(/local-seed: REFUSED.*production backup/u);
    expect(result.out).toMatch(/1 business the seed does not make/u);
    expect(result.out).not.toContain('harbour-freight-canary');
    expect(result.out).not.toMatch(/local-seed: business /u);
    expect(await keys()).toEqual(['harbour-freight-canary']);
  });

  it('S0-1 no production data: a real sign-in address is refused before any write', async () => {
    await reset();
    await business('alpha');
    await address('ada@alpha.local');
    await address('owner.canary@example.net');
    const result = seed();
    expect(result.status, result.out).toBe(1);
    expect(result.out).toMatch(/1 sign-in address that is not a made-up one/u);
    expect(result.out).not.toContain('owner.canary');
    expect(result.out).not.toContain(new URL(db.appUrl).password);
    expect(await keys()).toEqual(['alpha']);
  });

  it('S0-1 no production data: made-up data passes the check', async () => {
    await reset();
    await business('alpha');
    await business('bravo');
    await address('ada@alpha.local');
    expect(await productionSigns(db.admin, MADE_UP)).toEqual([]);
    await db.admin.execute('drop table auth.users');
    // A database with no auth schema at all has no addresses to judge.
    expect(await productionSigns(db.admin, MADE_UP)).toEqual([]);
    await db.admin.execute('create table auth.users (id uuid, email text)');
    await address('someone@example.com');
    await business('charlie');
    expect(await productionSigns(db.admin, MADE_UP)).toHaveLength(2);
  });
});
