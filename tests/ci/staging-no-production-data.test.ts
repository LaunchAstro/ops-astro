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
import { markMadeUp, productionSigns, type OwnerQuery } from '../../scripts/ops/made-up-only.ts';

const serverUrl = databaseUrlFromEnvironment();
const SEED = new URL('../../scripts/local-seed.mjs', import.meta.url).pathname;
const USERS_FILE = new URL('../../.local/synthetic-users.json', import.meta.url).pathname;
const MADE_UP = ['alpha', 'bravo'];

it('Sol proof, criterion 4: business-to-business and person-to-person rows are not counted by seed preflight', async () => {
  const statements: string[] = [];
  const owner: OwnerQuery = {
    async execute<Row>(statement: string): Promise<readonly Row[]> {
      statements.push(statement);
      if (statement.includes('to_regclass')) return [{ present: true }] as Row[];
      return [{ n: 0 }] as Row[];
    },
  };
  await productionSigns(owner, ['alpha']);
  const crossBoundaryCounts = statements.filter((statement) =>
    /select count\(\*\).*from (?:public\.businesses|auth\.users)/u.test(statement),
  );
  expect(crossBoundaryCounts).toEqual([]);
});

it('Sol proof, criterion 4: business-to-business and person-to-person rows are not read by yes-or-no preflight', async () => {
  const statements: string[] = [];
  const owner: OwnerQuery = {
    execute<Row>(statement: string): Promise<readonly Row[]> {
      statements.push(statement);
      if (statement.includes('shobj_description'))
        return Promise.resolve([{ mark: null }] as Row[]);
      return Promise.resolve([{ yes: statement.includes('to_regclass') }] as Row[]);
    },
  };
  await productionSigns(owner, ['alpha']);
  const crossBoundaryReads = statements.filter((statement) =>
    /exists \(select from (?:public\.businesses|auth\.users)/u.test(statement),
  );
  expect(crossBoundaryReads).toEqual([]);
});

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
    await db.admin.execute('delete from public.records');
    await db.admin.execute('delete from public.record_types');
    await db.admin.execute('delete from public.people');
    await db.admin.execute('delete from public.businesses');
    await db.admin.execute('delete from auth.users');
    const [unmark] = await db.admin.execute<{ statement: string }>(
      "select format('comment on database %I is null', current_database()) as statement",
    );
    await db.admin.execute(unmark!.statement);
  };
  const business = async (key: string): Promise<string> => {
    const id = randomUUID();
    await db.admin.execute(
      'insert into public.businesses (business_id, id, key, name) values ($1, $1, $2, $3)',
      [id, key, `${key} Pty Ltd`],
    );
    return id;
  };
  const address = (email: string): Promise<unknown> =>
    db.admin.execute('insert into auth.users (id, email) values ($1, $2)', [randomUUID(), email]);
  const seed = (confirm = false) => {
    const usersFileBefore = existsSync(USERS_FILE);
    const result = spawnSync(process.execPath, [SEED], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_ADMIN_URL: adminUrl,
        DATABASE_URL: db.appUrl,
        LOCAL_SEED_MADE_UP: confirm ? 'confirm' : '',
      },
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
    expect(result.out).toMatch(/local-seed: REFUSED, not provably made-up data/u);
    expect(result.out).toMatch(/it carries no made-up mark/u);
    expect(result.out).toMatch(/LOCAL_SEED_MADE_UP=confirm/u);
    expect(result.out).not.toContain('harbour-freight-canary');
    expect(result.out).not.toMatch(/local-seed: business /u);
    expect(await keys()).toEqual(['harbour-freight-canary']);
  });

  it('S0-1 no production data: a real sign-in address is refused before any write', async () => {
    await reset();
    await business('alpha');
    await address('ada@alpha.local');
    await address('owner.canary@example.net');
    // Confirmed, so the check reaches the sign-ins; unconfirmed it stops at the mark.
    const result = seed(true);
    expect(result.status, result.out).toBe(1);
    expect(result.out).toMatch(/it holds a sign-in that is not a made-up address/u);
    expect(result.out).not.toContain('owner.canary');
    expect(result.out).not.toContain(new URL(db.appUrl).password);
    expect(await keys()).toEqual(['alpha']);
  });

  it('S0-1 no production data: made-up data passes the check', async () => {
    await reset();
    await markMadeUp(db.admin, [await business('alpha'), await business('bravo')]);
    await address('ada@alpha.local');
    expect(await productionSigns(db.admin, MADE_UP)).toEqual([]);
    await db.admin.execute('drop table auth.users');
    // A database with no auth schema at all has no addresses to judge.
    expect(await productionSigns(db.admin, MADE_UP)).toEqual([]);
    await db.admin.execute('create table auth.users (id uuid, email text)');
    // A phone-only sign-in has no address, and the seed never makes one.
    await db.admin.execute('insert into auth.users (id, email) values ($1, null)', [randomUUID()]);
    expect(await productionSigns(db.admin, MADE_UP)).toEqual([
      'it holds a sign-in that is not a made-up address',
    ]);
    await address('someone@example.com');
    await business('charlie');
    expect(await productionSigns(db.admin, MADE_UP)).toHaveLength(2);
  });

  it('S0-1 no production data: a person confirms an unmarked made-up database once', async () => {
    await reset();
    await business('alpha');
    await business('bravo');
    expect(await productionSigns(db.admin, MADE_UP)).toEqual(['it carries no made-up mark']);
    expect(await productionSigns(db.admin, MADE_UP, true)).toEqual([]);
    await business('harbour-freight-canary');
    expect(await productionSigns(db.admin, MADE_UP, true)).toEqual([
      'it holds a business the seed did not make',
    ]);
  });

  it('S0-1 no production data: a malformed mark is no mark', async () => {
    await reset();
    await business('alpha');
    for (const comment of [
      'ops-astro made-up data; businesses: ',
      'OPS-ASTRO MADE-UP DATA; BUSINESSES: ; PEOPLE: ',
      ' ops-astro made-up data; businesses: ; people: ',
    ]) {
      // One database comment, rewritten per case: the cases run in turn by design.
      // oxlint-disable-next-line no-await-in-loop
      const [row] = await db.admin.execute<{ statement: string }>(
        "select format('comment on database %I is %L', current_database(), $1::text) as statement",
        [comment],
      );
      // oxlint-disable-next-line no-await-in-loop
      await db.admin.execute(row!.statement);
      // oxlint-disable-next-line no-await-in-loop
      expect(await productionSigns(db.admin, MADE_UP), comment).toEqual([
        'it carries no made-up mark',
      ]);
    }
  });

  it('S0-1 no production data: planted record content is refused by the seed and never printed', async () => {
    await reset();
    const businessId = await business('alpha');
    await markMadeUp(db.admin, [businessId]);
    const typeId = randomUUID();
    await db.admin.execute(
      'insert into public.record_types (business_id, id, key, name) values ($1, $2, $3, $4)',
      [businessId, typeId, 'private_note', 'Private note'],
    );
    await db.admin.execute(
      'insert into public.records (business_id, id, record_type_id, data) values ($1, $2, $3, $4)',
      [businessId, randomUUID(), typeId, { title: 'Private customer canary' }],
    );
    // A mark is always checked: the confirmation does not reopen a marked database.
    const result = seed(true);
    expect(result.status, result.out).toBe(1);
    expect(result.out).toMatch(/it holds a record the seed cannot vouch for/u);
    expect(result.out).not.toMatch(/Private customer canary|private_note|Private note/u);
    expect(result.out).not.toContain(businessId);
  });

  it('S0-1 no production data: task records people made in a marked database pass', async () => {
    await reset();
    const businessId = await business('alpha');
    await markMadeUp(db.admin, [businessId]);
    const typeId = randomUUID();
    await db.admin.execute(
      'insert into public.record_types (business_id, id, key, name) values ($1, $2, $3, $4)',
      [businessId, typeId, 'task', 'Task'],
    );
    await db.admin.execute(
      'insert into public.records (business_id, id, record_type_id, data) values ($1, $2, $3, $4)',
      [businessId, randomUUID(), typeId, { title: 'a made-up task' }],
    );
    expect(await productionSigns(db.admin, MADE_UP)).toEqual([]);
  });

  it('Sol proof, criterion 9: a backup with an allowed business key and production content is refused', async () => {
    await reset();
    const businessId = randomUUID();
    await db.admin.execute(
      'insert into public.businesses (business_id, id, key, name) values ($1, $1, $2, $3)',
      [businessId, 'alpha', 'alpha'],
    );
    await db.admin.execute(
      'insert into public.people (business_id, id, display_name) values ($1, $2, $3)',
      [businessId, randomUUID(), 'Private Customer Canary'],
    );
    const signs = await productionSigns(db.admin, MADE_UP);
    expect(signs).not.toEqual([]);
  });

  it('Sol proof, criterion 9: a marked database rejects restored person content', async () => {
    await reset();
    const businessId = await business('alpha');
    await markMadeUp(db.admin, [businessId]);
    await db.admin.execute(
      'insert into public.people (business_id, id, display_name) values ($1, $2, $3)',
      [businessId, randomUUID(), 'Restored Private Customer Canary'],
    );
    expect(await productionSigns(db.admin, MADE_UP)).not.toEqual([]);
  });

  it('Sol proof, criterion 9: confirmation cannot bless a backup with allowed business keys', async () => {
    await reset();
    const businessId = await business('alpha');
    await db.admin.execute(
      'insert into public.people (business_id, id, display_name) values ($1, $2, $3)',
      [businessId, randomUUID(), 'Production Person Canary'],
    );
    expect(await productionSigns(db.admin, MADE_UP, true)).not.toEqual([]);
  });

  it('Sol proof, criterion 9: confirmation cannot override a mismatched made-up mark', async () => {
    await reset();
    const originalId = await business('alpha');
    await markMadeUp(db.admin, [originalId]);
    await db.admin.execute('delete from public.businesses where id = $1', [originalId]);
    await business('alpha');
    expect(await productionSigns(db.admin, MADE_UP)).toContain(
      'it holds a business the seed did not make',
    );
    expect(await productionSigns(db.admin, MADE_UP, true, ['Ada Alpha'])).not.toEqual([]);
  });

  it('Sol proof, criterion 9: a marked database rejects restored private record content', async () => {
    await reset();
    const businessId = await business('alpha');
    await markMadeUp(db.admin, [businessId]);
    const typeId = randomUUID();
    await db.admin.execute(
      'insert into public.record_types (business_id, id, key, name) values ($1, $2, $3, $4)',
      [businessId, typeId, 'private_note', 'Private note'],
    );
    await db.admin.execute(
      'insert into public.records (business_id, id, record_type_id, data) values ($1, $2, $3, $4)',
      [businessId, randomUUID(), typeId, { title: 'Private customer canary' }],
    );
    expect(await productionSigns(db.admin, MADE_UP)).not.toEqual([]);
  });
});
