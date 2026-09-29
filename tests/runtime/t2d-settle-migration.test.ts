// SPDX-License-Identifier: AGPL-3.0-only
//
// T2d, migration 0034: the storage backstop 0026 lifted with the owner's
// acceptance (27 September 2026) and replaced by the settled-actual rules.
// `0026` itself stays byte-identical on disk; 0034 drops its first rule, keeps
// its second, and adds three: an actual reservation spends no more than it
// held, an attempt carries an actual exactly when it is settled, and that
// actual is positive. On a fresh database and on one seeded at 0033 through
// the runtime then upgraded: rows unchanged, the same constraints, each rule
// refused as the application role, and the worker holding nothing.

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  applyMigrations,
  migrate,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import { propose } from '../../packages/core-runtime/src/propose.ts';
import { decide } from '../../packages/core-runtime/src/decide.ts';
import {
  buildFixture,
  newTask,
  subjectsOf,
  TASK_COLLECTION,
  TEST_SIGNING_KEY,
  type RuntimeFixture,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/t2d-settle-migration: DATABASE_URL is unset, so nothing below ran.');
}

const onDisk = readMigrations('migrations');
const THROUGH_0033 = (version: string): boolean => version.slice(0, 4) <= '0033';
const BACKSTOP_0026 = '28554fabfe72a262c5344f6bc22885a646b959c44982137b373d441e9c9be97e';

/** One approved piece of work: its held reservation and its attempt. */
async function held(
  database: Database,
  fixture: RuntimeFixture,
): Promise<{ readonly reservationId: string; readonly attemptId: string }> {
  const taskId = await newTask(database, fixture.businessId, fixture.decider);
  return await database.withBusiness(fixture.businessId, async (tx) => {
    const proposed = await propose(tx, {
      taskId,
      collection: TASK_COLLECTION,
      proposedByActorId: fixture.decider.actorId,
      subjects: subjectsOf(fixture.decider),
      purpose: `t2d_${randomUUID().slice(0, 8)}`,
      maximumMinor: 2_500,
      currency: 'AUD',
      payload: { change: 'a comment' },
      step: { kind: 'synthetic_comment', payload: {} },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!proposed.ok) throw new Error(`propose refused ${proposed.refusal.code}`);
    const decided = await decide(tx, {
      gateId: proposed.value.gateId,
      versionId: proposed.value.versionId,
      decidedByPersonId: fixture.decider.personId,
      decidedByActorId: fixture.decider.actorId,
      subjects: subjectsOf(fixture.decider),
      collection: TASK_COLLECTION,
      decision: 'approve',
      note: 'go',
      signingKey: TEST_SIGNING_KEY,
      capId: fixture.capId,
    });
    if (!decided.ok || decided.value.decision !== 'approve') throw new Error('decide refused');
    const attempt = await tx.query<{ readonly id: string }>(
      'select id from public.attempts where business_id = $1 and reservation_id = $2',
      [tx.businessId, decided.value.reservationId],
    );
    return { reservationId: decided.value.reservationId, attemptId: String(attempt[0]?.id) };
  });
}

// T3d1: 0037 adds `absence_proved_at` to every hold, null on a row it did not
// answer, and T3e1's 0038 `drop_cause` and `provider_started_at` to every attempt; the comparison is of
// the rows 0034 must not rewrite, as T2c1's is.
async function rows(db: EmptyDatabase): Promise<unknown> {
  return await db.admin.execute(
    `select (select json_agg(to_jsonb(r) - 'absence_proved_at' order by r.id)
               from public.reservations r) as reservations,
            (select json_agg(to_jsonb(a) - 'drop_cause' - 'provider_started_at' order by a.id) from public.attempts a) as attempts`,
  );
}

async function constraints(db: EmptyDatabase): Promise<readonly { conname: string }[]> {
  return await db.admin.execute(
    `select conrelid::regclass::text as tab, conname, pg_get_constraintdef(oid) as def
       from pg_constraint
      where conrelid in ('public.reservations'::regclass, 'public.attempts'::regclass)
      order by 1, 2`,
  );
}

describe('0026 stays as it was approved', () => {
  it('is byte-identical on disk; 0034 lifts it, never an edit', () => {
    const bytes = readFileSync('migrations/0026_reservation_first_head_no_actual.sql');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(BACKSTOP_0026);
  });
});

describe.skipIf(serverUrl === undefined)('0034 settlement at the observed cost', () => {
  let fresh: EmptyDatabase;
  let upgraded: EmptyDatabase;
  let fixture: RuntimeFixture;
  let seededBefore: unknown;
  let seededAfter: unknown;

  beforeAll(async () => {
    fresh = await createEmptyDatabase({ part: 't2dmigfresh' });
    await applyMigrations(fresh.admin, onDisk);
    fixture = await buildFixture(fresh.app, 't2d-mig');

    upgraded = await createEmptyDatabase({ part: 't2dmigup' });
    await applyMigrations(
      upgraded.admin,
      onDisk.filter((m) => THROUGH_0033(m.version)),
    );
    const seed = await buildFixture(upgraded.app, 't2d-seed');
    await held(upgraded.app, seed);
    seededBefore = await rows(upgraded);
    await upgraded.closeSessions();
    await migrate(upgraded.admin, 'migrations');
    seededAfter = await rows(upgraded);
  }, 180_000);

  afterAll(async () => {
    await fresh?.drop();
    await upgraded?.drop();
  });

  it('rewrites no existing row, reads the same constraints fresh and upgraded, and has lifted 0026', async () => {
    expect(seededAfter).toStrictEqual(seededBefore);
    expect(await constraints(upgraded)).toStrictEqual(await constraints(fresh));
    const names = (await constraints(fresh)).map((row) => row.conname);
    expect(names).not.toContain('reservations_first_head_no_actual');
    expect(names).toEqual(
      expect.arrayContaining([
        'reservations_actual_positive',
        'reservations_actual_within_held',
        'attempts_actual_only_when_settled',
        'attempts_actual_positive',
      ]),
    );
  });

  const settle = (reservationId: string, attemptId: string, actual: number) =>
    fresh.app.withBusiness(fixture.businessId, async (tx) => {
      await tx.query(
        `update public.attempts set state = 'settled', actual_minor = $2, outcome = 'completed',
                settled_at = now() where id = $1`,
        [attemptId, actual],
      );
      await tx.query(
        `update public.reservations set state = 'actual', actual_minor = $2, terminal_at = now()
          where id = $1`,
        [reservationId, actual],
      );
    });

  it('commits a positive actual within the hold, as the application role', async () => {
    const one = await held(fresh.app, fixture);
    await settle(one.reservationId, one.attemptId, 1_800);
    const after = await fresh.admin.execute<{ readonly state: string }>(
      'select state from public.reservations where id = $1',
      [one.reservationId],
    );
    expect(after[0]?.state).toBe('actual');
  });

  it.each([
    ['an actual above the hold', 2_501, 'reservations_actual_within_held'],
    ['a zero actual', 0, 'attempts_actual_positive'],
    ['a negative actual', -5, 'attempts_actual_not_negative'],
  ] as const)('refuses %s (%s)', async (_label, actual, constraint) => {
    const one = await held(fresh.app, fixture);
    await expect(settle(one.reservationId, one.attemptId, actual)).rejects.toMatchObject({
      constraint_name: constraint,
    });
  });

  it.each([
    ['a settled attempt with no actual', `state = 'settled', settled_at = now()`],
    ['an actual on an attempt that is not settled', `actual_minor = 100`],
  ] as const)('refuses %s', async (_label, set) => {
    const one = await held(fresh.app, fixture);
    await expect(
      fresh.app.withBusiness(fixture.businessId, async (tx) => {
        await tx.query(`update public.attempts set ${set} where id = $1`, [one.attemptId]);
      }),
    ).rejects.toMatchObject({ constraint_name: 'attempts_actual_only_when_settled' });
  });

  it('T2 worker role: the worker holds nothing on reservations or attempts', async () => {
    const holds = await fresh.admin.execute<{ readonly any: boolean }>(
      `select bool_or(has_table_privilege('ops_astro_worker', t, p)) as any
         from unnest(array['public.reservations', 'public.attempts', 'public.task_envelopes']) t,
              unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p`,
    );
    expect(holds[0]?.any).toBe(false);
  });
});
