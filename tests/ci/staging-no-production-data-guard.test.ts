// SPDX-License-Identifier: AGPL-3.0-only
// S0-1 no production data, continued: the row guard switched off, dropped,
// bypassed or raced, a table made after the mark, and Sol's criterion 9 proofs on
// restored content. The helpers are staging-no-production-data.fixture.ts; the
// seed's own checks are in staging-no-production-data.test.ts.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';
import {
  admitMadeUp,
  markMadeUp,
  productionSigns,
  type OwnerQuery,
} from '../../scripts/ops/made-up-only.ts';
import { serverUrl, MADE_UP } from './staging-no-production-data.fixture.ts';

if (serverUrl === undefined) {
  console.warn('S0-1 no production data: DATABASE_URL is unset, so nothing below ran.');
}

let db: FreshDatabase;

const reset = async (): Promise<void> => {
  await db.admin.execute('drop event trigger if exists ops_astro_made_up_guard');
  await db.admin.execute('drop schema if exists ops_astro_made_up cascade');
  await db.admin.execute('delete from public.records');
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

describe.skipIf(serverUrl === undefined)('S0-1 no production data', () => {
  beforeAll(async () => {
    db = await createFreshDatabase({ part: 's01a' });
    await db.admin.execute('create schema if not exists auth');
    await db.admin.execute('create table if not exists auth.users (id uuid, email text)');
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  noProductionDataCases5();
  noProductionDataCases6();
  noProductionDataCases7();
  noProductionDataCasesSolNarrow();
  noProductionDataCases8();
});

function noProductionDataCases5() {
  it('S0-1 no production data: a guard switched off, dropped or bypassed is refused', async () => {
    const guarded = async (): Promise<string> => {
      await reset();
      const businessId = await business('alpha');
      await markMadeUp(db.admin, [businessId]);
      expect(await productionSigns(db.admin, MADE_UP)).toEqual([]);
      return businessId;
    };
    // pg_restore --disable-triggers, then the guard switched back on.
    await guarded();
    await db.admin.execute('alter table public.people disable trigger all');
    await db.admin.execute('alter table public.people enable trigger all');
    expect(await productionSigns(db.admin, MADE_UP)).toContain('a made-up guard was switched off');
    // A superuser in replica mode, where ordinary triggers do not fire.
    let businessId = await guarded();
    // One statement, so the setting and the write share a transaction on the pool.
    await db.admin.execute(
      `insert into public.people (business_id, id, display_name)
         select $1, $2, $3 from (select set_config('session_replication_role', 'replica', true)) r`,
      [businessId, randomUUID(), 'Replica Person Canary'],
    );
    expect(await productionSigns(db.admin, MADE_UP)).toContain(
      'it holds a person the seed did not make',
    );
    // A guard dropped, or the watch removed.
    await guarded();
    await db.admin.execute('drop trigger ops_astro_made_up_guard on public.records');
    expect(await productionSigns(db.admin, MADE_UP)).toContain('a table has no made-up guard');
    await guarded();
    await db.admin.execute('drop event trigger ops_astro_made_up_guard');
    expect(await productionSigns(db.admin, MADE_UP)).toContain('a table has no made-up guard');
    // A tenant table filled as it is made is never vouched for.
    businessId = await guarded();
    await db.admin.execute(
      `create table public.s01a_loaded as select $1::uuid as business_id, 'Loaded canary' as note`,
      [businessId],
    );
    try {
      expect(await productionSigns(db.admin, MADE_UP)).toContain('a table has no made-up guard');
    } finally {
      await db.admin.execute('drop table public.s01a_loaded');
    }
  });
}

function noProductionDataCases6() {
  it('S0-1 no production data: a row landing between the check and the guard is refused', async () => {
    await reset();
    let planted = false;
    const racing: OwnerQuery = {
      execute: async (text, parameters) => {
        const rows = await db.admin.execute(text, parameters);
        // The first new-database answer is given; then another session writes.
        if (!planted && text.includes('pg_relation_size')) {
          planted = true;
          await db.admin.execute(
            'insert into public.businesses (business_id, id, key, name) values ($1, $1, $2, $3)',
            [randomUUID(), 'racing-canary', 'Racing canary'],
          );
        }
        return rows as never;
      },
    };
    expect(await admitMadeUp(racing, true)).toEqual([
      'it carries no made-up mark and is not a new database',
    ]);
    expect(planted).toBe(true);
  });

  it('S0-1 no production data: a table made after the mark is guarded from its first row', async () => {
    await reset();
    const businessId = await business('alpha');
    await markMadeUp(db.admin, [businessId]);
    await db.admin.execute('create table public.s01a_later (business_id uuid, note text)');
    try {
      expect(await productionSigns(db.admin, MADE_UP)).toEqual([]);
      await db.admin.execute('insert into public.s01a_later values ($1, $2)', [
        businessId,
        'Later private canary',
      ]);
      expect(await productionSigns(db.admin, MADE_UP)).toEqual([
        'it holds a record the seed cannot vouch for',
      ]);
    } finally {
      await db.admin.execute('drop table public.s01a_later');
    }
  });
}

function noProductionDataCases7() {
  it('a backup with an allowed business key and production content is refused', async () => {
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

  it('a marked database rejects restored person content', async () => {
    await reset();
    const businessId = await business('alpha');
    await markMadeUp(db.admin, [businessId]);
    await db.admin.execute(
      'insert into public.people (business_id, id, display_name) values ($1, $2, $3)',
      [businessId, randomUUID(), 'Restored Private Customer Canary'],
    );
    expect(await productionSigns(db.admin, MADE_UP)).not.toEqual([]);
  });

  it('confirmation cannot bless a backup with allowed business keys', async () => {
    await reset();
    const businessId = await business('alpha');
    await db.admin.execute(
      'insert into public.people (business_id, id, display_name) values ($1, $2, $3)',
      [businessId, randomUUID(), 'Production Person Canary'],
    );
    expect(await productionSigns(db.admin, MADE_UP, true)).not.toEqual([]);
  });
}

function noProductionDataCasesSolNarrow() {
  it('Sol narrow proof: a restored task row cannot claim the seed tag as provenance', async () => {
    await reset();
    const businessId = await business('alpha');
    await markMadeUp(db.admin, [businessId]);
    const typeId = randomUUID();
    await db.admin.execute(
      `insert into public.record_types (business_id, id, key, name)
       select $1, $2, 'task', 'Task'
       from (select set_config('ops_astro.writer', 'seed', true)) as forged`,
      [businessId, typeId],
    );
    await db.admin.execute(
      `insert into public.records (business_id, id, record_type_id, data)
       select $1, $2, $3, $4
       from (select set_config('ops_astro.writer', 'seed', true)) as forged`,
      [businessId, randomUUID(), typeId, { title: 'Restored private customer canary' }],
    );
    expect(await admitMadeUp(db.admin, true)).not.toEqual([]);
  });
}

function noProductionDataCases8() {
  it('confirmation cannot override a mismatched made-up mark', async () => {
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

  it('a marked database rejects restored private record content', async () => {
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

  it('Sol proof, criterion 9: a marked task type rejects restored private record content', async () => {
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
      [businessId, randomUUID(), typeId, { title: 'Restored private customer canary' }],
    );
    expect(await productionSigns(db.admin, MADE_UP)).not.toEqual([]);
  });
}
