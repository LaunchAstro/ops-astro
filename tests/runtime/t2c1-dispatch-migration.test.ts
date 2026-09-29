// SPDX-License-Identifier: AGPL-3.0-only
//
// T2c1, migration 0033: the three constraint changes that let a step be
// marked dispatched (spike RN-05).
//
// As the application role: a step marked dispatched with no attempt named, a
// step naming an attempt that carries no marker or belongs to another step,
// and a marker outside its owning states are all refused; the owning writes,
// marker first and then the step's reference, commit. The known states admit
// `settled` and `liability_unknown`. On a database seeded at 0032 through the
// runtime and upgraded, every existing row is unchanged, and the two tables'
// constraints read the same as on a fresh database. The worker role holds
// nothing on either table, new columns included.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import type { Database, TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { propose } from '../../packages/core-runtime/src/propose.ts';
import { decide } from '../../packages/core-runtime/src/decide.ts';
import { pickup } from '../../packages/core-runtime/src/pickup.ts';
import { handback } from '../../packages/core-runtime/src/handback.ts';
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
  console.warn('runtime/t2c1-dispatch-migration: DATABASE_URL is unset, so nothing below ran.');
}

const onDisk = readMigrations('migrations');
// Through T2a's 0032 run_events, which the runtime that seeds below writes to.
const THROUGH_0032 = (version: string): boolean => version.slice(0, 4) <= '0032';
// And T2h's 0036 alerts: that runtime raises an alert when it hands back.
// 0036 reads nothing 0033 to 0035 add, and the runner applies whatever is
// pending, so the upgrade below still applies 0033 onto these rows.
const SEEDED = (version: string): boolean =>
  THROUGH_0032(version) || version.slice(0, 4) === '0036';

/** Proposes work on the task and approves it, answering the reservation the approval made. */
async function approvedReservation(
  tx: TenantQuery,
  fixture: RuntimeFixture,
  taskId: string,
): Promise<string> {
  const proposed = await propose(tx, {
    taskId,
    collection: TASK_COLLECTION,
    proposedByActorId: fixture.decider.actorId,
    subjects: subjectsOf(fixture.decider),
    purpose: `t2c1_${randomUUID().slice(0, 8)}`,
    maximumMinor: 2_000,
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
  return decided.value.reservationId;
}

/** One approved and picked-up piece of work; `handedBack` settles it too. */
async function work(
  database: Database,
  fixture: RuntimeFixture,
  handedBack: boolean,
): Promise<{ readonly attemptId: string; readonly stepId: string; readonly leaseId: string }> {
  const taskId = await newTask(database, fixture.businessId, fixture.decider);
  return await database.withBusiness(fixture.businessId, async (tx) => {
    const reservationId = await approvedReservation(tx, fixture, taskId);
    const picked = await pickup(tx, {
      claimant: 'agent',
      reservationId,
      agentActorId: fixture.agentActorId,
      authorisedByPersonId: fixture.decider.personId,
      mintedByActorId: fixture.decider.actorId,
      collection: TASK_COLLECTION,
      leaseSeconds: 600,
    });
    if (!picked.ok) throw new Error(`pickup refused ${picked.refusal.code}`);
    if (handedBack) {
      const back = await handback(tx, {
        leaseId: picked.value.leaseId,
        fence: picked.value.fence,
        outcome: 'completed',
        report: { wrote: 'a comment' },
        actualMinor: null,
      });
      if (!back.ok) throw new Error(`handback refused ${back.refusal.code}`);
    }
    const step = await tx.query<{ readonly step_id: string }>(
      'select step_id from public.attempts where business_id = $1 and id = $2',
      [tx.businessId, picked.value.attemptId],
    );
    return {
      attemptId: picked.value.attemptId,
      stepId: String(step[0]?.step_id),
      leaseId: picked.value.leaseId,
    };
  });
}

/** Every attempt and step, row by row, as the owner reads them. */
async function rows(db: EmptyDatabase): Promise<unknown> {
  return await db.admin.execute(
    `select (select json_agg(to_jsonb(a) - 'drop_cause' order by a.id) from public.attempts a) as attempts,
            (select json_agg(to_jsonb(s) - 'dispatch_attempt_id' - 'dispatch_marked'
                             order by s.id) from public.planned_steps s) as steps`,
  );
}

/** The two tables' constraints, by name and definition. */
async function constraints(db: EmptyDatabase): Promise<unknown> {
  return await db.admin.execute(
    `select conrelid::regclass::text as tab, conname, pg_get_constraintdef(oid) as def
       from pg_constraint
      where conrelid in ('public.attempts'::regclass, 'public.planned_steps'::regclass)
      order by 1, 2`,
  );
}

describe.skipIf(serverUrl === undefined)('0033 the dispatch mark', () => {
  let fresh: EmptyDatabase;
  let upgraded: EmptyDatabase;
  let fixture: RuntimeFixture;
  let seededBefore: unknown;
  let seededAfter: unknown;

  beforeAll(async () => {
    fresh = await createEmptyDatabase({ part: 't2c1migfresh' });
    await applyMigrations(fresh.admin, onDisk);
    fixture = await buildFixture(fresh.app, 't2c1-mig');

    upgraded = await createEmptyDatabase({ part: 't2c1migup' });
    await applyMigrations(
      upgraded.admin,
      onDisk.filter((m) => SEEDED(m.version)),
    );
    const seed = await buildFixture(upgraded.app, 't2c1-seed');
    await work(upgraded.app, seed, false);
    await work(upgraded.app, seed, true);
    seededBefore = await rows(upgraded);
    await upgraded.closeSessions();
    await migrate(upgraded.admin, 'migrations');
    seededAfter = await rows(upgraded);
  }, 180_000);

  afterAll(async () => {
    await fresh?.drop();
    await upgraded?.drop();
  });

  it('rewrites no existing row, and reads the same constraints fresh and upgraded', async () => {
    expect(seededAfter).toStrictEqual(seededBefore);
    expect(await constraints(upgraded)).toStrictEqual(await constraints(fresh));
    const names = (await constraints(fresh)) as readonly { readonly conname: string }[];
    expect(names.map((row) => row.conname)).not.toContain('planned_steps_undispatched');
    expect(names.map((row) => row.conname)).not.toContain('attempts_marked_is_quarantined');
  });

  it('commits the owning writes: the marker first, then the step naming its own attempt', async () => {
    const one = await work(fresh.app, fixture, false);
    await fresh.app.withBusiness(fixture.businessId, async (tx) => {
      await tx.query('update public.attempts set dispatch_marker = true where id = $1', [
        one.attemptId,
      ]);
      await tx.query(
        `update public.planned_steps
            set dispatched_at = now(), dispatch_attempt_id = $2, dispatch_marked = true
          where id = $1`,
        [one.stepId, one.attemptId],
      );
    });
  });

  it.each([
    ['a step marked with no attempt named', 'planned_steps_dispatch_named', 'noattempt'],
    ['a step naming an unmarked attempt', 'planned_steps_dispatch_attempt_fkey', 'unmarked'],
    ['a step naming another step’s attempt', 'planned_steps_dispatch_attempt_fkey', 'foreign'],
    ['a marker on a reserved attempt', 'attempts_marker_in_owning_state', 'reserved'],
    ['a marker on a handed-back attempt', 'attempts_marker_in_owning_state', 'handedback'],
  ] as const)('refuses %s (%s)', async (_label, constraint, shape) => {
    const one = await work(fresh.app, fixture, shape === 'handedback');
    const two = await work(fresh.app, fixture, false);
    const write = fresh.app.withBusiness(fixture.businessId, async (tx) => {
      if (shape === 'noattempt') {
        await tx.query('update public.planned_steps set dispatched_at = now() where id = $1', [
          one.stepId,
        ]);
      } else if (shape === 'unmarked' || shape === 'foreign') {
        const attempt = shape === 'unmarked' ? one.attemptId : two.attemptId;
        if (shape === 'foreign') {
          await tx.query('update public.attempts set dispatch_marker = true where id = $1', [
            attempt,
          ]);
        }
        await tx.query(
          `update public.planned_steps
              set dispatched_at = now(), dispatch_attempt_id = $2, dispatch_marked = true
            where id = $1`,
          [one.stepId, attempt],
        );
      } else {
        if (shape === 'reserved') {
          await tx.query(`update public.attempts set state = 'reserved' where id = $1`, [
            one.attemptId,
          ]);
        }
        await tx.query('update public.attempts set dispatch_marker = true where id = $1', [
          one.attemptId,
        ]);
      }
    });
    await expect(write).rejects.toMatchObject({ constraint_name: constraint });
  });

  it('admits settled and liability_unknown as known attempt states', async () => {
    const defs = (await constraints(fresh)) as readonly { conname: string; def: string }[];
    const known = defs.find((row) => row.conname === 'attempts_state_known')?.def ?? '';
    expect(known).toContain("'settled'");
    expect(known).toContain("'liability_unknown'");
  });

  it('T2 worker role: the worker holds nothing on either table, the new columns included', async () => {
    const held = await fresh.admin.execute<{ readonly any: boolean }>(
      `select bool_or(has_table_privilege('ops_astro_worker', t, p)) or
              bool_or(has_column_privilege('ops_astro_worker', 'public.planned_steps', c, cp)) as any
         from unnest(array['public.attempts', 'public.planned_steps']) t,
              unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p,
              unnest(array['dispatch_attempt_id', 'dispatch_marked']) c,
              unnest(array['SELECT', 'INSERT', 'UPDATE']) cp`,
    );
    expect(held[0]?.any).toBe(false);
  });
});
