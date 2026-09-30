// SPDX-License-Identifier: AGPL-3.0-only
//
// C4, migration 0042 on main's chain. The live change record was written as
// 0036, straight after T2f's 0035, on a branch that did not have main's 0036
// to 0041; it now runs after them. On a database seeded at 0041 and then
// upgraded, and on a fresh one: the seeded rows are unchanged and nothing is
// stamped by the upgrade itself, the two live functions are the ones a fresh
// chain has, and on the upgraded database a write to a task still reaches
// T2f's topic on the channel and stamps the change record once.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../support/fresh-database.ts';
import {
  applyMigrations,
  migrate,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import { connectListener, type Listener } from '../../packages/core-records/src/index.ts';
import { startLiveTopics, type LiveSignal, type LiveTopics } from '../../apps/api/live.ts';
import { buildFixture, type RuntimeFixture } from '../runtime/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('api/c4-change-record-upgrade: DATABASE_URL is unset, so nothing below ran.');
}

const onDisk = readMigrations('migrations');
const THROUGH_0041 = (version: string): boolean => version.slice(0, 4) <= '0041';

/** The rows a seeded database holds before the upgrade. */
async function dump(db: EmptyDatabase): Promise<unknown> {
  return await db.admin.execute(
    `select (select count(*) from public.records)::text as records,
            (select string_agg(id::text || ':' || revision::text, ',' order by id)
               from public.records) as revisions`,
  );
}

/** The two live trigger functions, as the catalogue defines them. */
async function liveFunctions(db: EmptyDatabase): Promise<unknown> {
  return await db.admin.execute(
    `select proname as name, pg_get_functiondef(oid) as def,
            has_function_privilege('public', oid, 'execute') as public_execute
       from pg_proc
      where proname in ('live_task_topic', 'live_record_topics')
      order by 1`,
  );
}

/** A write to the seed's task on `db`: heard on T2f's topic, stamped once in the record. */
async function writeReachesTopic(db: EmptyDatabase, seed: RuntimeFixture): Promise<void> {
  let listener: Listener | undefined;
  let topics: LiveTopics | undefined;
  const heard: LiveSignal[] = [];
  try {
    listener = connectListener(db.appUrl);
    topics = await startLiveTopics(listener);
    topics.subscribe(seed.businessId, seed.taskId, (signal) => heard.push(signal));
    await db.app.withBusiness(seed.businessId, async (tx) => {
      await tx.query('update public.records set data = data where id = $1', [seed.taskId]);
    });
    await vi.waitFor(() => expect(heard).toContain('invalidate'), { timeout: 5_000 });
    expect(
      await db.admin.execute(
        'select business_id::text as business, subject_kind as kind, subject_id::text as id from public.live_changes',
      ),
    ).toEqual([{ business: seed.businessId, kind: 'task', id: seed.taskId }]);
  } finally {
    await topics?.close();
    await listener?.close();
  }
}

describe.skipIf(serverUrl === undefined)("0042 the live change record on main's chain", () => {
  let fresh: EmptyDatabase;
  let upgraded: EmptyDatabase;
  let seed: RuntimeFixture;
  let seededBefore: unknown;

  beforeAll(async () => {
    fresh = await createEmptyDatabase({ part: 'c4upfresh' });
    await applyMigrations(fresh.admin, onDisk);

    upgraded = await createEmptyDatabase({ part: 'c4upup' });
    await applyMigrations(
      upgraded.admin,
      onDisk.filter((m) => THROUGH_0041(m.version)),
    );
    seed = await buildFixture(upgraded.app, 'c4-up-seed');
    seededBefore = await dump(upgraded);
    await upgraded.closeSessions();
    await migrate(upgraded.admin, 'migrations');
  }, 180_000);

  afterAll(async () => {
    await fresh?.drop();
    await upgraded?.drop();
  });

  it('C4 upgrade: a database at 0041 upgrades with its rows unchanged, nothing stamped, and the live functions a fresh chain has', async () => {
    expect(await dump(upgraded)).toStrictEqual(seededBefore);
    expect(
      await upgraded.admin.execute('select count(*)::int as n from public.live_changes'),
    ).toEqual([{ n: 0 }]);
    const functions = await liveFunctions(upgraded);
    expect(functions).toStrictEqual(await liveFunctions(fresh));
    expect(JSON.stringify(functions).match(/public\.live_changes/gu)).toHaveLength(2);
  });

  it("C4 upgrade: on the upgraded database a write to a task reaches T2f's topic and stamps the change record once", async () => {
    await writeReachesTopic(upgraded, seed);
  });
});
