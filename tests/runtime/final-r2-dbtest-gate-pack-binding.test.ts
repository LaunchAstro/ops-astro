// SPDX-License-Identifier: AGPL-3.0-only
//
// FR2-P2, migration 0030: a gate's evidence pack is its version's, and a
// decided gate keeps its version.
//
// 0021 tied a gate's run, step and lineage to its version, but not its pack:
// `gates_evidence_fkey` names the pack by business and id only. The
// application role alone could point a decided gate at another version's pack,
// or add a superseded version with its own run, step and pack and move the
// decided gate onto it (FR2-RUNTIME, "Found on the way"). Since ad7baff the
// proposal read notices and answers DECISION_INTEGRITY; Nathan approved
// storage refusing the write as well.
//
// Every tampering below is the application role's, inside `withBusiness`,
// never the owner's. The runtime's own propose, decide and a request-changes
// then approve on a new version still commit. The same cases run on a
// database migrated from empty and on one migrated to 0029, seeded through the
// runtime, and then upgraded: fresh and upgraded behave the same, and the
// seeded rows survive the upgrade byte for byte. A 0029 database already
// holding a row the rule forbids stops before 0030 with the row untouched.

import { randomUUID } from 'node:crypto';
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
  type MigrationOutcome,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import type { Database, TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
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
    'runtime/final-r2-dbtest-gate-pack-binding: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const THROUGH_0029 = (version: string): boolean => version.slice(0, 4) <= '0029';

const PACK_OF_VERSION = { code: '23503', constraint_name: 'gates_pack_in_same_version' };
const VERSION_FIXED = { code: '23514', constraint_name: 'gates_version_fixed_once_decided' };

const onDisk = readMigrations('migrations');

type Decision = 'approve' | 'reject' | 'request_changes';

interface Proposed {
  readonly taskId: string;
  readonly gateId: string;
  readonly versionId: string;
  readonly lineageId: string;
}

/** Through the runtime's own propose, on a new task unless a lineage is named. */
async function proposed(
  database: Database,
  fixture: RuntimeFixture,
  on: { readonly taskId?: string; readonly lineageId?: string } = {},
): Promise<Proposed> {
  const taskId = on.taskId ?? (await newTask(database, fixture.businessId, fixture.decider));
  return await database.withBusiness(fixture.businessId, async (tx) => {
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
      ...(on.lineageId === undefined ? {} : { lineageId: on.lineageId }),
    });
    if (!result.ok) throw new Error(`propose refused ${result.refusal.code}`);
    return {
      taskId,
      gateId: result.value.gateId,
      versionId: result.value.versionId,
      lineageId: result.value.lineageId,
    };
  });
}

/** Through the runtime's own decide. */
async function decided(
  database: Database,
  fixture: RuntimeFixture,
  on: Proposed,
  decision: Decision,
): Promise<void> {
  await database.withBusiness(fixture.businessId, async (tx) => {
    const result = await decide(tx, {
      gateId: on.gateId,
      versionId: on.versionId,
      decidedByPersonId: fixture.decider.personId,
      decidedByActorId: fixture.decider.actorId,
      subjects: subjectsOf(fixture.decider),
      collection: TASK_COLLECTION,
      decision,
      note: `${decision} as proposed`,
      signingKey: TEST_SIGNING_KEY,
      capId: fixture.capId,
    });
    if (!result.ok) throw new Error(`decide refused ${result.refusal.code}`);
  });
}

/** An approved proposal on a new task. */
async function approved(database: Database, fixture: RuntimeFixture): Promise<Proposed> {
  const on = await proposed(database, fixture);
  await decided(database, fixture, on, 'approve');
  return on;
}

async function packOf(tx: TenantQuery, versionId: string): Promise<string> {
  const [row] = await tx.query<{ readonly id: string }>(
    'select id from public.evidence_packs where business_id = $1 and version_id = $2',
    [tx.businessId, versionId],
  );
  if (row === undefined) throw new Error(`no pack for version ${versionId}`);
  return row.id;
}

/**
 * A superseded version 99 added to `from`'s lineage, with its own run and
 * step copied from `from`'s and, when asked, its own consistent pack. The
 * integrity suite's case (c) setup, as the application role.
 */
async function addVersion(
  tx: TenantQuery,
  from: string,
  withPack: boolean,
): Promise<{
  readonly versionId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly packId: string | null;
}> {
  const versionId = randomUUID();
  const runId = randomUUID();
  const stepId = randomUUID();
  const v = [tx.businessId, from] as const;
  await tx.query(
    `insert into public.proposal_versions
       (business_id, id, lineage_id, version, payload, payload_digest, purpose,
        maximum_minor, currency, proposed_by_actor_id, superseded_at)
     select business_id, $3, lineage_id, 99, payload, payload_digest, purpose,
            999999, currency, proposed_by_actor_id, now()
       from public.proposal_versions where business_id = $1 and id = $2`,
    [...v, versionId],
  );
  await tx.query(
    `insert into public.planned_runs (business_id, id, lineage_id, version_id, task_id, state)
     select business_id, $3, lineage_id, $4, task_id, state
       from public.planned_runs where business_id = $1 and version_id = $2`,
    [...v, runId, versionId],
  );
  await tx.query(
    `insert into public.planned_steps (business_id, id, run_id, ordinal, kind, payload)
     select s.business_id, $3, $4, s.ordinal, s.kind, s.payload
       from public.planned_steps s
       join public.planned_runs r on r.business_id = s.business_id and r.id = s.run_id
      where s.business_id = $1 and r.version_id = $2`,
    [...v, stepId, runId],
  );
  if (!withPack) return { versionId, runId, stepId, packId: null };
  const packId = randomUUID();
  await tx.query(
    `insert into public.evidence_packs
       (business_id, id, version_id, run_id, rendered, rendered_digest, version_digest, renderer)
     select business_id, $3, $4, $5, rendered, rendered_digest, version_digest, renderer
       from public.evidence_packs where business_id = $1 and version_id = $2`,
    [...v, packId, versionId, runId],
  );
  return { versionId, runId, stepId, packId };
}

/**
 * The three tamperings, each as the application role in one transaction.
 * `other` is a second proposal in the business, made before the state is read.
 */
const TAMPERINGS = {
  /** (a) A decided gate pointed at another version's pack. */
  async repointPack(
    database: Database,
    fixture: RuntimeFixture,
    on: Proposed,
    other: Proposed,
  ): Promise<void> {
    await database.withBusiness(fixture.businessId, async (tx) => {
      await tx.query(
        `update public.gates set evidence_pack_id = $3 where business_id = $1 and id = $2`,
        [tx.businessId, on.gateId, await packOf(tx, other.versionId)],
      );
    });
  },
  /** (b) A decided gate moved onto a superseded version with its own run, step and pack. */
  async moveGate(database: Database, fixture: RuntimeFixture, on: Proposed): Promise<void> {
    await database.withBusiness(fixture.businessId, async (tx) => {
      const added = await addVersion(tx, on.versionId, true);
      await tx.query(
        `update public.gates set version_id = $3, run_id = $4, step_id = $5, evidence_pack_id = $6
          where business_id = $1 and id = $2`,
        [tx.businessId, on.gateId, added.versionId, added.runId, added.stepId, added.packId],
      );
    });
  },
  /** (c) A new gate on a new version, naming another version's pack. */
  async insertGate(database: Database, fixture: RuntimeFixture, on: Proposed): Promise<void> {
    await database.withBusiness(fixture.businessId, async (tx) => {
      const added = await addVersion(tx, on.versionId, false);
      await tx.query(
        `insert into public.gates
           (business_id, id, lineage_id, version_id, run_id, step_id, evidence_pack_id,
            payload_digest, expires_at)
         select business_id, $3, lineage_id, $4, $5, $6, evidence_pack_id, payload_digest, expires_at
           from public.gates where business_id = $1 and id = $2`,
        [tx.businessId, on.gateId, randomUUID(), added.versionId, added.runId, added.stepId],
      );
    });
  },
} as const;

/** Every gate, pack and version in the business, as the owner reads them. */
async function proposalState(db: EmptyDatabase, businessId: string): Promise<string> {
  const [row] = await db.admin.execute<{ readonly all: string | null }>(
    `select coalesce((select string_agg(g::text, '|' order by g.id) from public.gates g
                       where g.business_id = $1), '') || '#' ||
            coalesce((select string_agg(p::text, '|' order by p.id) from public.evidence_packs p
                       where p.business_id = $1), '') || '#' ||
            coalesce((select string_agg(v::text, '|' order by v.id) from public.proposal_versions v
                       where v.business_id = $1), '') as all`,
    [businessId],
  );
  return row?.all ?? '';
}

/** Every gate, pack, version and decision in the database, as the owner reads them. */
async function seedSnapshot(db: EmptyDatabase): Promise<string> {
  const [row] = await db.admin.execute<{ readonly all: string | null }>(
    `select coalesce((select string_agg(g::text, '|' order by g.id) from public.gates g), '') || '#' ||
            coalesce((select string_agg(p::text, '|' order by p.id) from public.evidence_packs p), '') || '#' ||
            coalesce((select string_agg(v::text, '|' order by v.id) from public.proposal_versions v), '') || '#' ||
            coalesce((select string_agg(d::text, '|' order by d.id) from public.gate_decisions d), '')
       as all`,
  );
  return row?.all ?? '';
}

interface Built {
  readonly db: EmptyDatabase;
  readonly migration: MigrationOutcome;
  readonly seeded?: string;
  readonly seededAfter?: string;
}

async function fresh(): Promise<Built> {
  const db = await createEmptyDatabase({ part: 'packbindfresh' });
  return { db, migration: await applyMigrations(db.admin, onDisk) };
}

/** A 0029 database with a clean approval and a request-changes-then-approve history. */
async function seededAt0029(
  part: string,
): Promise<{ readonly db: EmptyDatabase; readonly seed: RuntimeFixture }> {
  const db = await createEmptyDatabase({ part });
  await applyMigrations(
    db.admin,
    onDisk.filter((m) => THROUGH_0029(m.version)),
  );
  const seed = await buildFixture(db.app, `seed-0029-${part}`);
  await approved(db.app, seed);
  const first = await proposed(db.app, seed);
  await decided(db.app, seed, first, 'request_changes');
  const second = await proposed(db.app, seed, { taskId: first.taskId, lineageId: first.lineageId });
  await decided(db.app, seed, second, 'approve');
  return { db, seed };
}

async function upgraded(): Promise<Built> {
  const { db } = await seededAt0029('packbindupgraded');
  const seeded = await seedSnapshot(db);
  const migration = await migrate(db.admin, 'migrations');
  return { db, migration, seeded, seededAfter: await seedSnapshot(db) };
}

describe.skipIf(serverUrl === undefined).each([
  ['fresh', fresh],
  ['upgraded from 0029', upgraded],
] as const)('a gate is bound to its version pack on a %s database', (label, build) => {
  let built: Built;
  let fixture: RuntimeFixture;

  beforeAll(async () => {
    built = await build();
    fixture = await buildFixture(built.db.app, `packbind-${label.replaceAll(' ', '-')}`);
  }, 120_000);

  afterAll(async () => {
    await built?.db.drop();
  });

  it('applies every migration once, the upgrade only those after 0029', () => {
    const through = onDisk.filter((m) => THROUGH_0029(m.version)).map((m) => m.version);
    const after = onDisk.filter((m) => !THROUGH_0029(m.version)).map((m) => m.version);
    expect(after.map((v) => v.slice(0, 4))).toContain('0030');
    const expected =
      label === 'fresh'
        ? { applied: [...through, ...after], alreadyApplied: [] }
        : { applied: after, alreadyApplied: through };
    expect({
      applied: built.migration.applied,
      alreadyApplied: built.migration.alreadyApplied,
    }).toStrictEqual(expected);
  });

  // Only the upgraded leg has seeded rows, so only it registers the case.
  if (label !== 'fresh') {
    it('keeps every seeded row as it was', () => {
      const [gates, packs, versions, decisions] = (built.seeded ?? '').split('#');
      expect(gates?.split('|')).toHaveLength(3);
      expect(packs?.split('|')).toHaveLength(3);
      expect(versions?.split('|')).toHaveLength(3);
      expect(decisions).toMatch(/request_changes/u);
      expect(built.seededAfter).toBe(built.seeded);
    });
  }

  it.each([
    [
      '(a) points a decided gate at another version’s pack',
      TAMPERINGS.repointPack,
      PACK_OF_VERSION,
    ],
    [
      '(b) moves a decided gate onto a superseded version with its own run, step and pack',
      TAMPERINGS.moveGate,
      VERSION_FIXED,
    ],
    ['(c) inserts a gate naming another version’s pack', TAMPERINGS.insertGate, PACK_OF_VERSION],
  ] as const)(
    'refuses the application role when it %s, and moves nothing',
    async (_label, tamper, refusal) => {
      const on = await approved(built.db.app, fixture);
      const other = await proposed(built.db.app, fixture);
      const before = await proposalState(built.db, fixture.businessId);
      await expect(tamper(built.db.app, fixture, on, other)).rejects.toMatchObject(refusal);
      expect(await proposalState(built.db, fixture.businessId)).toBe(before);
    },
  );

  // R4-THERMO-4: the trigger has two guards, and each case below needs one
  // of them alone. (d) holds only while a decision names the gate; (e) only
  // while the gate has left `pending`.
  it('refuses the application role when it (d) resets a decided gate to pending and then moves it, and moves nothing', async () => {
    const on = await approved(built.db.app, fixture);
    const before = await proposalState(built.db, fixture.businessId);
    await expect(
      built.db.app.withBusiness(fixture.businessId, async (tx) => {
        await tx.query(
          `update public.gates set state = 'pending', decided_at = null
            where business_id = $1 and id = $2`,
          [tx.businessId, on.gateId],
        );
        const added = await addVersion(tx, on.versionId, true);
        await tx.query(
          `update public.gates set version_id = $3, run_id = $4, step_id = $5, evidence_pack_id = $6
            where business_id = $1 and id = $2`,
          [tx.businessId, on.gateId, added.versionId, added.runId, added.stepId, added.packId],
        );
      }),
    ).rejects.toMatchObject(VERSION_FIXED);
    expect(await proposalState(built.db, fixture.businessId)).toBe(before);
  });

  it('refuses the application role when it (e) moves a superseded gate with no decision, and moves nothing', async () => {
    const first = await proposed(built.db.app, fixture);
    await proposed(built.db.app, fixture, { taskId: first.taskId, lineageId: first.lineageId });
    const [gate] = await built.db.admin.execute<{
      readonly state: string;
      readonly decided: boolean;
    }>(
      `select g.state, exists (select 1 from public.gate_decisions d
                                where d.business_id = g.business_id and d.gate_id = g.id) as decided
         from public.gates g where g.id = $1`,
      [first.gateId],
    );
    expect(gate).toStrictEqual({ state: 'superseded', decided: false });
    const before = await proposalState(built.db, fixture.businessId);
    await expect(TAMPERINGS.moveGate(built.db.app, fixture, first)).rejects.toMatchObject(
      VERSION_FIXED,
    );
    expect(await proposalState(built.db, fixture.businessId)).toBe(before);
  });

  it('commits the runtime’s own propose and approve', async () => {
    const on = await approved(built.db.app, fixture);
    const [row] = await built.db.admin.execute<{ readonly state: string; readonly bound: boolean }>(
      `select g.state, p.version_id = g.version_id as bound
         from public.gates g join public.evidence_packs p
           on p.business_id = g.business_id and p.id = g.evidence_pack_id
        where g.id = $1`,
      [on.gateId],
    );
    expect(row).toStrictEqual({ state: 'approved', bound: true });
  });

  it('commits the runtime’s request changes, then approve on a new version', async () => {
    const first = await proposed(built.db.app, fixture);
    await decided(built.db.app, fixture, first, 'request_changes');
    const second = await proposed(built.db.app, fixture, {
      taskId: first.taskId,
      lineageId: first.lineageId,
    });
    expect(second.versionId).not.toBe(first.versionId);
    await decided(built.db.app, fixture, second, 'approve');
    const rows = await built.db.admin.execute<{ readonly state: string }>(
      `select g.state from public.gates g join public.evidence_packs p
          on p.business_id = g.business_id and p.id = g.evidence_pack_id
         and p.version_id = g.version_id
        where g.id = any($1::uuid[]) order by g.round`,
      [[first.gateId, second.gateId]],
    );
    expect(rows.map((row) => row.state)).toStrictEqual(['changes_requested', 'approved']);
  });

  it('leaves a pending gate on its own version free to be decided, and a decided gate’s state writable', async () => {
    const on = await proposed(built.db.app, fixture);
    await decided(built.db.app, fixture, on, 'reject');
    const [row] = await built.db.admin.execute<{ readonly state: string }>(
      'select state from public.gates where id = $1',
      [on.gateId],
    );
    expect(row?.state).toBe('rejected');
  });
});

describe.skipIf(serverUrl === undefined)('a 0029 database holding a row 0030 forbids', () => {
  it.each([
    ['a decided gate pointed at another version’s pack', TAMPERINGS.repointPack],
    ['a decided gate moved onto another version', TAMPERINGS.moveGate],
    ['a gate naming another version’s pack', TAMPERINGS.insertGate],
  ] as const)(
    'refuses the upgrade for %s, stopping at 0029 with the rows untouched',
    async (_label, tamper) => {
      const { db, seed } = await seededAt0029('packbindrefused');
      try {
        // At 0029 nothing in storage stops it; this is the red.
        const on = await approved(db.app, seed);
        await tamper(db.app, seed, on, await proposed(db.app, seed));
        const seeded = await seedSnapshot(db);
        await expect(migrate(db.admin, 'migrations')).rejects.toSatisfy((error: unknown) =>
          /gates:/u.test(String((error as { cause?: unknown }).cause ?? error)),
        );
        const [ledger] = await db.admin.execute<{ readonly last: string }>(
          `select max(version) as last from ops.schema_migrations`,
        );
        expect(ledger?.last.slice(0, 4)).toBe('0029');
        expect(await seedSnapshot(db)).toBe(seeded);
      } finally {
        await db.drop();
      }
    },
    120_000,
  );
});
