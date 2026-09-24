// SPDX-License-Identifier: AGPL-3.0-only
//
// SOL-R3R-1, migration 0030 during its own upgrade: a decided gate keeps its
// version even when the application moves it while 0030 is running.
//
// 0030 checks the rows already written (a decided gate's version against its
// decision's) and only then installs the trigger that refuses a version change.
// An application connection still on 0029 has UPDATE on `gates` (0011), so
// without a lock held from before the check it could move a decided gate onto
// another version, with that version's run, step and pack, between the two and
// commit. The upgrade then succeeded holding the very state 0030 forbids.
//
// Two schedules, each on a database built to 0029, seeded through the runtime
// with an approved gate, and given, as the application role and committed, a
// superseded version in the gate's lineage with its own run, step and pack:
//
//   1. The owner runs 0030's statements in one transaction, as the migration
//      runner does, and pauses after the check block. The application makes
//      the move. It must wait for 0030 and then be refused by its trigger.
//   2. The application makes the move and holds its transaction open while
//      the owner starts the upgrade. The upgrade must wait for the move, then
//      refuse it and stay at 0029.
//
// Every move is the application role's, inside `withBusiness`.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
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
import {
  connectAsAdmin,
  type AdminConnection,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
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
  console.warn(
    'runtime/final-r3r-0030-upgrade-race: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const onDisk = readMigrations('migrations');
const THROUGH_0029 = onDisk.filter((m) => m.version.slice(0, 4) <= '0029');
const UPGRADE = onDisk.find((m) => m.version.startsWith('0030'));

const VERSION_FIXED = { code: '23514', constraint_name: 'gates_version_fixed_once_decided' };

type Outcome = { readonly committed: true } | { readonly refused: unknown };

/** A promise's outcome, never a rejection, so a refusal can be awaited later. */
async function settle(work: Promise<unknown>): Promise<Outcome> {
  try {
    await work;
    return { committed: true };
  } catch (error) {
    return { refused: error };
  }
}

/** A promise and the call that resolves it, for holding one side of a schedule. */
function latch(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  const box: { resolve?: () => void } = {};
  const promise = new Promise<void>((resolve) => {
    box.resolve = resolve;
  });
  return { promise, resolve: () => box.resolve?.() };
}

interface Staged {
  readonly db: EmptyDatabase;
  /**
   * A second owner connection that watches the others. The owner pool holds
   * one connection, which the upgrade's transaction occupies.
   */
  readonly watch: AdminConnection;
  readonly fixture: RuntimeFixture;
  readonly gateId: string;
  readonly decidedVersionId: string;
  readonly target: {
    readonly versionId: string;
    readonly runId: string;
    readonly stepId: string;
    readonly packId: string;
  };
}

/**
 * A 0029 database with a gate approved through the runtime, and a superseded
 * version 99 in its lineage with its own run, step and pack, committed by the
 * application role. Moving the gate onto it satisfies everything 0021 and
 * 0030's pack key check.
 */
async function stagedAt0029(part: string): Promise<Staged> {
  if (UPGRADE === undefined) throw new Error('no 0030 on disk');
  const db = await createEmptyDatabase({ part });
  await applyMigrations(db.admin, THROUGH_0029);
  const fixture = await buildFixture(db.app, `race-0030-${part}`);
  const taskId = await newTask(db.app, fixture.businessId, fixture.decider);
  const gate = await db.app.withBusiness(fixture.businessId, async (tx) => {
    const result = await propose(tx, {
      taskId,
      collection: TASK_COLLECTION,
      proposedByActorId: fixture.decider.actorId,
      subjects: subjectsOf(fixture.decider),
      purpose: 'draft_the_brief',
      maximumMinor: 5_000,
      currency: 'AUD',
      payload: { instruction: 'draft it' },
      step: { kind: 'local.draft', payload: { words: 200 } },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!result.ok) throw new Error(`propose refused ${result.refusal.code}`);
    return result.value;
  });
  await db.app.withBusiness(fixture.businessId, async (tx) => {
    const result = await decide(tx, {
      gateId: gate.gateId,
      versionId: gate.versionId,
      decidedByPersonId: fixture.decider.personId,
      decidedByActorId: fixture.decider.actorId,
      subjects: subjectsOf(fixture.decider),
      collection: TASK_COLLECTION,
      decision: 'approve',
      note: 'approve as proposed',
      signingKey: TEST_SIGNING_KEY,
      capId: fixture.capId,
    });
    if (!result.ok) throw new Error(`decide refused ${result.refusal.code}`);
  });
  const target = await db.app.withBusiness(fixture.businessId, async (tx) => {
    const ids = {
      versionId: randomUUID(),
      runId: randomUUID(),
      stepId: randomUUID(),
      packId: randomUUID(),
    };
    const v = [tx.businessId, gate.versionId] as const;
    await tx.query(
      `insert into public.proposal_versions
         (business_id, id, lineage_id, version, payload, payload_digest, purpose,
          maximum_minor, currency, proposed_by_actor_id, superseded_at)
       select business_id, $3, lineage_id, 99, payload, payload_digest, purpose,
              999999, currency, proposed_by_actor_id, now()
         from public.proposal_versions where business_id = $1 and id = $2`,
      [...v, ids.versionId],
    );
    await tx.query(
      `insert into public.planned_runs (business_id, id, lineage_id, version_id, task_id, state)
       select business_id, $3, lineage_id, $4, task_id, state
         from public.planned_runs where business_id = $1 and version_id = $2`,
      [...v, ids.runId, ids.versionId],
    );
    await tx.query(
      `insert into public.planned_steps (business_id, id, run_id, ordinal, kind, payload)
       select s.business_id, $3, $4, s.ordinal, s.kind, s.payload
         from public.planned_steps s
         join public.planned_runs r on r.business_id = s.business_id and r.id = s.run_id
        where s.business_id = $1 and r.version_id = $2`,
      [...v, ids.stepId, ids.runId],
    );
    await tx.query(
      `insert into public.evidence_packs
         (business_id, id, version_id, run_id, rendered, rendered_digest, version_digest, renderer)
       select business_id, $3, $4, $5, rendered, rendered_digest, version_digest, renderer
         from public.evidence_packs where business_id = $1 and version_id = $2`,
      [...v, ids.packId, ids.versionId, ids.runId],
    );
    return ids;
  });
  const url = new URL(serverUrl ?? '');
  url.pathname = `/${db.name}`;
  const watch = connectAsAdmin(url.toString());
  return { db, watch, fixture, gateId: gate.gateId, decidedVersionId: gate.versionId, target };
}

/** The move: the decided gate onto the staged version, with its run, step and pack. */
async function move(tx: TenantQuery, on: Staged): Promise<void> {
  await tx.query(
    `update public.gates set version_id = $3, run_id = $4, step_id = $5, evidence_pack_id = $6
      where business_id = $1 and id = $2`,
    [
      tx.businessId,
      on.gateId,
      on.target.versionId,
      on.target.runId,
      on.target.stepId,
      on.target.packId,
    ],
  );
}

/** Whether another backend on this database is waiting for a lock. */
async function someoneWaits(watch: AdminConnection): Promise<boolean> {
  const [row] = await watch.execute<{ readonly waiting: boolean }>(
    `select exists (select 1 from pg_stat_activity
                     where datname = current_database() and wait_event_type = 'Lock') as waiting`,
  );
  return row?.waiting === true;
}

/** Polls until the work finishes or a lock wait appears, whichever the schedule reaches first. */
async function committedOrWaiting(
  watch: AdminConnection,
  work: Promise<Outcome>,
): Promise<'finished' | 'waiting'> {
  let finished = false;
  void work.finally(() => {
    finished = true;
  });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (finished) return 'finished';
    // Polling is sequential by nature.
    // oxlint-disable-next-line no-await-in-loop
    if (await someoneWaits(watch)) return 'waiting';
    // oxlint-disable-next-line no-await-in-loop
    await delay(25);
  }
  throw new Error('the schedule neither finished nor waited on a lock within 10 seconds');
}

/** The gate's version and its decision's, as the owner reads them. */
async function versions(
  on: Staged,
): Promise<{ readonly gate: string | undefined; readonly decision: string | undefined }> {
  const [row] = await on.db.admin.execute<{ readonly gate: string; readonly decision: string }>(
    `select g.version_id::text as gate, d.version_id::text as decision
       from public.gates g
       join public.gate_decisions d on d.business_id = g.business_id and d.gate_id = g.id
      where g.id = $1`,
    [on.gateId],
  );
  return { gate: row?.gate, decision: row?.decision };
}

async function lastApplied(db: EmptyDatabase): Promise<string | undefined> {
  const [row] = await db.admin.execute<{ readonly last: string }>(
    `select max(version) as last from ops.schema_migrations`,
  );
  return row?.last.slice(0, 4);
}

describe.skipIf(serverUrl === undefined)(
  '0030 against a decided-gate move made during its upgrade',
  () => {
    let staged: Staged | undefined;

    afterEach(async () => {
      await staged?.watch.close();
      await staged?.db.drop();
      staged = undefined;
    });

    it('makes the move wait while 0030 is between its check and its trigger, then refuses it', async () => {
      const on = await stagedAt0029('race0030mid');
      staged = on;
      const upgrade = UPGRADE;
      if (upgrade === undefined) throw new Error('no 0030 on disk');
      let moving: Promise<Outcome> | undefined;
      let during: 'finished' | 'waiting' | undefined;
      // 0030 exactly as the runner applies it: its statements in order, then its
      // ledger row, in one transaction. The pause is after the check block.
      await on.db.admin.transaction(async (execute) => {
        for (const statement of upgrade.statements) {
          // oxlint-disable-next-line no-await-in-loop
          await execute(statement);
          if (/\bdo \$\$/u.test(statement)) {
            moving = settle(
              on.db.app.withBusiness(on.fixture.businessId, async (tx) => await move(tx, on)),
            );
            // oxlint-disable-next-line no-await-in-loop
            during = await committedOrWaiting(on.watch, moving);
          }
        }
        await execute(`insert into ops.schema_migrations (version, checksum) values ($1, $2)`, [
          upgrade.version,
          upgrade.checksum,
        ]);
      });
      const moved = await moving;
      // The rest of the chain applies on top, so the upgrade as a whole succeeded.
      await migrate(on.db.admin, 'migrations');
      expect({
        during,
        moved: moved !== undefined && 'refused' in moved ? 'refused' : 'committed',
        versions: await versions(on),
      }).toStrictEqual({
        during: 'waiting',
        moved: 'refused',
        versions: { gate: on.decidedVersionId, decision: on.decidedVersionId },
      });
      expect(moved).toMatchObject({ refused: VERSION_FIXED });
      expect(await lastApplied(on.db)).not.toBe('0029');
    }, 120_000);

    it('makes the upgrade wait for a move already in flight, then refuses the upgrade at 0029', async () => {
      const on = await stagedAt0029('race0030first');
      staged = on;
      const held = latch();
      const madeTheMove = latch();
      const moving = settle(
        on.db.app.withBusiness(on.fixture.businessId, async (tx) => {
          await move(tx, on);
          madeTheMove.resolve();
          await held.promise;
        }),
      );
      await madeTheMove.promise;
      const upgrading = settle(migrate(on.db.admin, 'migrations'));
      const during = await committedOrWaiting(on.watch, upgrading).finally(() => {
        held.resolve();
      });
      const moved = await moving;
      const upgraded = await upgrading;
      expect({
        during,
        moved: 'committed' in moved ? 'committed' : 'refused',
        upgraded: 'refused' in upgraded ? 'refused' : 'committed',
        last: await lastApplied(on.db),
      }).toStrictEqual({
        during: 'waiting',
        moved: 'committed',
        upgraded: 'refused',
        last: '0029',
      });
      expect(upgraded).toSatisfy(
        (outcome: Outcome) =>
          'refused' in outcome &&
          /decided gate .* but its decision is on version/u.test(
            String((outcome.refused as { cause?: unknown }).cause ?? outcome.refused),
          ),
      );
    }, 120_000);
  },
);
