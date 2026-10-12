// SPDX-License-Identifier: AGPL-3.0-only
//
// Two seed runs admitted to one staging database, one after the other, each on
// its own connection. Each process makes its own seed tag at start, so each run
// here is its own load of made-up-only.ts. The second admission must leave the
// first run's tag good: the first run's own writes are not noted as foreign,
// and a write neither run tagged still is.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEmptyDatabase, type EmptyDatabase } from '../support/fresh-database.ts';
import {
  connectAsAdmin,
  type AdminConnection,
} from '../../packages/core-records/src/tenancy/database.ts';
import { serverUrl } from './staging-no-production-data.fixture.ts';

type MadeUpOnly = typeof import('../../scripts/ops/made-up-only.ts');

/** A seed process: its own load of the module, so its own tag, and its own session. */
interface SeedRun {
  readonly module: MadeUpOnly;
  readonly session: AdminConnection;
}

let db: EmptyDatabase | undefined;
const sessions: AdminConnection[] = [];

async function seedRun(): Promise<SeedRun> {
  vi.resetModules();
  const module = await import('../../scripts/ops/made-up-only.ts');
  const url = new URL(serverUrl ?? '');
  url.pathname = `/${db?.name ?? ''}`;
  const session = connectAsAdmin(url.toString(), { source: 'seed' });
  sessions.push(session);
  await module.bindSeed(session);
  return { module, session };
}

/** A tenant row written on `run`'s session, tagged as that run's seed. */
async function seedWrite(run: SeedRun, name: string): Promise<void> {
  await run.session.execute(
    `insert into public.things (business_id, id, name) select $1, $1, $2 from ${run.module.SEED_TAG}`,
    [randomUUID(), name],
  );
}

async function ledger(): Promise<string[]> {
  const rows =
    (await db?.admin.execute<{ readonly relation: string }>(
      'select relation from ops_astro_made_up.untrusted order by relation',
    )) ?? [];
  return rows.map((row) => row.relation);
}

describe.skipIf(serverUrl === undefined)('two seed admissions on one database', () => {
  beforeAll(async () => {
    db = await createEmptyDatabase({ part: 'seedtwo' });
    await db.admin.execute('create schema auth');
    await db.admin.execute('create table auth.users (id uuid, email text)');
    await db.admin.execute('create table public.things (business_id uuid, id uuid, name text)');
    const { markMadeUp } = await import('../../scripts/ops/made-up-only.ts');
    await markMadeUp(db.admin, []);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(sessions.splice(0).map(async (session) => await session.close()));
    await db?.drop();
  });

  it("a second seed's admission keeps the first seed's own writes vouched for", async () => {
    const first = await seedRun();
    expect(await first.module.admitMadeUp(first.session, false)).toEqual([]);
    const second = await seedRun();
    expect(second.module.SEED_TAG).not.toBe(first.module.SEED_TAG);
    expect(await second.module.admitMadeUp(second.session, false)).toEqual([]);

    await seedWrite(first, 'First seed thing');
    expect(await ledger()).toEqual([]);
    await seedWrite(second, 'Second seed thing');
    expect(await ledger()).toEqual([]);

    // A write no seed tagged, on the owner's own connection, is still noted.
    await db?.admin.execute(
      `insert into public.things (business_id, id, name) values ($1, $1, 'Untagged canary')`,
      [randomUUID()],
    );
    expect(await ledger()).toEqual(['public.things']);
  }, 60_000);
});
