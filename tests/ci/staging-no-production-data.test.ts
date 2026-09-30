// SPDX-License-Identifier: AGPL-3.0-only
// S0-1a: staging's database holds made-up data only, so the seed refuses a
// database it cannot vouch for from its own mark and guard: no mark, a write
// the seed and the application did not make, a sign-in that is not a made-up
// address, or a guard switched off. It decides from that metadata, never from
// a tenant's rows, and the refusal comes before the seed writes a row or a
// file, naming no row.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';
import { markMadeUp, productionSigns, type OwnerQuery } from '../../scripts/ops/made-up-only.ts';
import { serverUrl, USERS_FILE, MADE_UP } from './staging-no-production-data.fixture.ts';

const SEED = new URL('../../scripts/local-seed.mjs', import.meta.url).pathname;

it('business-to-business and person-to-person rows are not counted by seed preflight', async () => {
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

it('business-to-business and person-to-person rows are not read by yes-or-no preflight', async () => {
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

it('marked preflight preserves business-to-business, client-to-client and person-to-person separation', async () => {
  const statements: string[] = [];
  const owner: OwnerQuery = {
    execute<Row>(statement: string): Promise<readonly Row[]> {
      statements.push(statement);
      if (statement.includes('shobj_description'))
        return Promise.resolve([{ mark: 'ops-astro made-up data; businesses: ; people: ' }] as Row[]);
      return Promise.resolve([{ yes: statement.includes('to_regclass') }] as Row[]);
    },
  };
  await productionSigns(owner, ['alpha']);
  const crossBoundaryReads = statements.filter((statement) =>
    /(?:from|join) public\.(?:businesses|people|records)\b|from auth\.users\b/u.test(statement),
  );
  expect(crossBoundaryReads).toEqual([]);
});

if (serverUrl === undefined) {
  console.warn('S0-1 no production data: DATABASE_URL is unset, so nothing below ran.');
}

let db: FreshDatabase;

let adminUrl: string;

const reset = async (): Promise<void> => {
  await db.admin.execute('drop event trigger if exists ops_astro_made_up_guard');
  await db.admin.execute('drop schema if exists ops_astro_made_up cascade');
  await db.admin.execute('delete from public.records');
  // The live change record's stamps (C4, 0059) hold the business by a key.
  await db.admin.execute('delete from public.live_changes');
  await db.admin.execute('delete from public.record_types');
  await db.admin.execute('delete from public.people');
  await db.admin.execute('delete from public.businesses');
  await db.admin.execute('delete from auth.users');
  const [unmark] = await db.admin.execute<{ statement: string }>(
    "select format('comment on database %I is null', current_database()) as statement",
  );
  await db.admin.execute(unmark!.statement);
  // Emptied tables give their pages back, so an emptied database is a new one.
  for (const table of ['public.records', 'public.record_types', 'public.people'])
    // oxlint-disable-next-line no-await-in-loop
    await db.admin.execute(`vacuum ${table}`);
  await db.admin.execute('vacuum public.businesses');
  await db.admin.execute('vacuum auth.users');
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

describe.skipIf(serverUrl === undefined)('S0-1 no production data', () => {
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

  noProductionDataCases1();
  noProductionDataCases2();
  noProductionDataCases3();
  noProductionDataCases4();
});

function noProductionDataCases1() {
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
    await markMadeUp(db.admin, [await business('alpha')]);
    await address('ada@alpha.local');
    await address('owner.canary@example.net');
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
}

function noProductionDataCases2() {
  it('S0-1 no production data: a person confirms a new database once, never one holding rows', async () => {
    await reset();
    expect(await productionSigns(db.admin, MADE_UP)).toEqual(['it carries no made-up mark']);
    expect(await productionSigns(db.admin, MADE_UP, true)).toEqual([]);
    await business('harbour-freight-canary');
    expect(await productionSigns(db.admin, MADE_UP, true)).toEqual([
      'it carries no made-up mark and is not a new database',
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
}

function noProductionDataCases3() {
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

  it('S0-1 no production data: records people make through the application pass', async () => {
    await reset();
    const businessId = await business('alpha');
    await markMadeUp(db.admin, [businessId]);
    await db.app.withBusiness(businessId as never, async (tx) => {
      const typeId = randomUUID();
      await tx.query(
        'insert into public.record_types (business_id, id, key, name) values ($1, $2, $3, $4)',
        [businessId, typeId, 'task', 'Task'],
      );
      await tx.query(
        'insert into public.records (business_id, id, record_type_id, data) values ($1, $2, $3, $4)',
        [businessId, randomUUID(), typeId, { title: 'a made-up task' }],
      );
    });
    expect(await productionSigns(db.admin, MADE_UP)).toEqual([]);
  });
}

function noProductionDataCases4() {
  it('S0-1 no production data: the check reads no tenant row, only the mark, the guard and the catalogue', async () => {
    await reset();
    await markMadeUp(db.admin, [await business('alpha')]);
    const statements: string[] = [];
    const watched: OwnerQuery = {
      execute: (text, parameters) => {
        statements.push(text);
        return db.admin.execute(text, parameters);
      },
    };
    expect(await productionSigns(watched, MADE_UP)).toEqual([]);
    expect(await productionSigns(watched, MADE_UP, true)).toEqual([]);
    expect(statements.join('\n')).not.toMatch(
      /(?:from|join)\s+(?:public|auth)\.\w+|\b(?:public|auth)\.(?:businesses|people|records|users)\b/u,
    );
  });
}
