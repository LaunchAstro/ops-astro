// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  applyMigrations,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import { liveWork, openSchedules, seedSchedules, type Schedules } from './schedules-harness.ts';
import { seedPin } from './aw-02-world.ts';
interface RunRows {
  readonly run_id: string;
  readonly step_id: string;
  readonly lease_id: string;
  readonly version_id: string;
  readonly reservation_id: string;
  readonly attempt_id: string;
  readonly task_id: string;
}
type Row = Record<string, string | number | boolean | null>;
let s: Schedules;
let own: RunRows;
let other: RunRows;
let sequence = 0;
async function insert(table: string, row: Row): Promise<void> {
  const entries = Object.entries({ business_id: s.business, id: randomUUID(), ...row });
  await s.db.app.withBusiness(s.business, async (tx) => {
    await tx.query(
      `insert into public.${table} (${entries.map(([key]) => key).join(', ')})
       values (${entries.map((_, index) => `$${index + 1}`).join(', ')})`,
      entries.map(([, value]) => value),
    );
  });
}
function child(table: string): Row {
  if (table === 'bootstrap_reads') {
    return {
      run_id: own.run_id,
      step_id: own.step_id,
      sequence: ++sequence,
      path: 'skills/brief/SKILL.md',
      content_digest: 'a'.repeat(64),
      content_size: 1,
      is_entry: false,
    };
  }
  if (table === 'run_checks') {
    return {
      run_id: own.run_id,
      task_id: own.task_id,
      version_id: own.version_id,
      lease_id: own.lease_id,
      attempt_id: own.attempt_id,
      actor_id: s.agentActorId,
      fence: 1,
      name: 'run check',
      outcome: 'passed',
    };
  }
  return {
    run_id: own.run_id,
    step_id: own.step_id,
    version_id: own.version_id,
    lease_id: own.lease_id,
    reservation_id: own.reservation_id,
    operation_key: 'test.compose',
    state: 'liability_unknown',
    reserved_minor: 1,
    route_key: 'test',
    route_reach: 'cloud',
    credential_kind: 'replay',
    drop_cause: 'provider_unavailable',
    fault: 'provider',
    provider_code: 'http_503',
    unknown_since: new Date().toISOString(),
  };
}
function conversationCall(conversationId: string): Row {
  return {
    conversation_id: conversationId,
    operation_key: 'test.compose',
    route_key: 'test',
    route_reach: 'local',
    credential_kind: 'replay',
    state: 'reserved',
    reserved_minor: 0,
  };
}
async function seedRunRows(): Promise<void> {
  const first = await liveWork(s, 'First run', 2_000);
  const second = await liveWork(s, 'Second run', 2_000);
  const rows = await s.db.admin.execute<RunRows>(
    `select a.run_id, a.step_id, a.lease_id, a.version_id, a.reservation_id,
              a.id as attempt_id, l.task_id
         from public.attempts a join public.leases l
           on l.business_id = a.business_id and l.id = a.lease_id
        where a.business_id = $1 and a.lease_id in ($2, $3)`,
    [s.business, first.picked['leaseId'], second.picked['leaseId']],
  );
  const firstRow = rows.find((row) => row.lease_id === first.picked['leaseId']);
  const secondRow = rows.find((row) => row.lease_id === second.picked['leaseId']);
  if (firstRow === undefined || secondRow === undefined) throw new Error('missing run rows');
  own = firstRow;
  other = secondRow;
  await seedPin(s, own.run_id);
}
const CROSS_RUN = [
  ['bootstrap_reads', 'step_id'],
  ['run_checks', 'lease_id'],
  ['run_checks', 'attempt_id'],
  ['run_checks', 'task_id'],
  ['model_calls', 'step_id'],
  ['model_calls', 'lease_id'],
  ['model_calls', 'reservation_id'],
  ['model_calls', 'version_id'],
] as const;
const VERSION = '20261007043048_run_bound_keys';
const ALL = readMigrations('migrations');
async function snapshot(): Promise<unknown> {
  return await s.db.admin.execute(
    `select * from (
       select 'bootstrap_reads' as table_name, to_jsonb(r) as row from public.bootstrap_reads r
       union all select 'run_checks', to_jsonb(r) from public.run_checks r
       union all select 'model_calls', to_jsonb(r) from public.model_calls r
     ) rows order by table_name, row::text`,
  );
}
describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'run-side rows stay with their run',
  // oxlint-disable-next-line max-lines-per-function -- register the related database cases together.
  () => {
    beforeAll(async () => {
      s = await openSchedules('runbound', 1_000_000);
      await seedRunRows();
    }, 60_000);

    afterAll(async () => {
      await s?.db.drop();
    });

    it.each(CROSS_RUN)(
      "%s refuses another run's %s as the application role",
      async (table, column) => {
        await expect(
          insert(table, { ...child(table), [column]: other[column] }),
        ).rejects.toMatchObject({
          code: '23503',
        });
      },
    );

    it.each(['bootstrap_reads', 'run_checks', 'model_calls'])(
      '%s accepts references within the same run as the application role',
      async (table) => {
        await expect(insert(table, child(table))).resolves.toBeUndefined();
      },
    );

    it('accepts a conversation call with null run references as the application role', async () => {
      const conversationId = randomUUID();
      await s.db.app.withBusiness(s.business, async (tx) => {
        await tx.query(
          `insert into public.conversations (business_id, id, owner_actor_id, owner_person_id, title)
         values ($1, $2, $3, $4, 'Local conversation')`,
          [s.business, conversationId, s.decider.actorId, s.decider.personId],
        );
      });
      await expect(
        insert('model_calls', conversationCall(conversationId)),
      ).resolves.toBeUndefined();
    });

    it('accepts an entry bootstrap read without a step as the application role', async () => {
      await expect(
        insert('bootstrap_reads', { ...child('bootstrap_reads'), step_id: null, is_entry: true }),
      ).resolves.toBeUndefined();
    });
  },
);
// oxlint-disable-next-line max-lines-per-function -- the group owns its migration fixture and cases.
describe.skipIf(databaseUrlFromEnvironment() === undefined)('run-bound keys on an upgrade', () => {
  let beforeDirectory: string;

  beforeAll(() => {
    beforeDirectory = mkdtempSync(join(tmpdir(), 'run-bound-before-'));
    for (const file of readdirSync('migrations')) {
      if (file.endsWith('.sql') && file < `${VERSION}.sql`) {
        copyFileSync(join('migrations', file), join(beforeDirectory, file));
      }
    }
  });

  beforeEach(async () => {
    s = await seedSchedules(
      await createFreshDatabase({ part: 'runboundupgrade', migrationsDirectory: beforeDirectory }),
      'runboundupgrade',
      1_000_000,
    );
    await seedRunRows();
  }, 60_000);

  afterEach(async () => {
    await s?.db.drop();
  });

  afterAll(() => {
    rmSync(beforeDirectory, { recursive: true, force: true });
  });

  async function refusedUpgrade(reference: string): Promise<void> {
    const before = await snapshot();
    const ledger = await s.db.admin.execute('select * from ops.schema_migrations order by version');
    await s.db.closeSessions();
    await expect(applyMigrations(s.db.admin, ALL)).rejects.toMatchObject({
      cause: {
        code: '23503',
        message: `run-bound references: ${reference} contains orphaned or cross-run rows`,
      },
    });
    expect(await snapshot()).toEqual(before);
    expect(
      await s.db.admin.execute('select * from ops.schema_migrations order by version'),
    ).toEqual(ledger);
    expect(
      await s.db.admin.execute(
        `select conname from pg_constraint
          where conname in ('planned_steps_run_id_key', 'leases_run_id_key',
                            'attempts_run_id_key', 'reservations_run_id_key')`,
      ),
    ).toEqual([]);
  }

  it.each(CROSS_RUN)(
    'stops before changing keys for existing cross-run %s.%s',
    async (table, column) => {
      await expect(
        insert(table, { ...child(table), [column]: other[column] }),
      ).resolves.toBeUndefined();
      await refusedUpgrade(`${table}.${column}`);
    },
  );

  it('stops before changing keys for an existing orphaned bootstrap read', async () => {
    await s.db.admin.execute(
      'alter table public.bootstrap_reads drop constraint bootstrap_reads_step_fkey',
    );
    await insert('bootstrap_reads', { ...child('bootstrap_reads'), step_id: randomUUID() });
    await refusedUpgrade('bootstrap_reads.step_id');
  });

  it('keeps same-run rows unchanged and refuses cross-run inserts after upgrading', async () => {
    await insert('bootstrap_reads', child('bootstrap_reads'));
    await insert('run_checks', child('run_checks'));
    await insert('model_calls', child('model_calls'));
    const before = await snapshot();
    await s.db.closeSessions();
    const applied = await applyMigrations(s.db.admin, ALL);
    expect(applied.applied).toContain(VERSION);
    expect(await snapshot()).toEqual(before);
    await expect(
      insert('bootstrap_reads', { ...child('bootstrap_reads'), step_id: other.step_id }),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(insert('bootstrap_reads', child('bootstrap_reads'))).resolves.toBeUndefined();
    await expect(insert('run_checks', child('run_checks'))).resolves.toBeUndefined();
    await expect(insert('model_calls', child('model_calls'))).resolves.toBeUndefined();
  });

  it('the upgrade drill keeps stored rows unchanged through the run-bound migration', () => {
    const at = ALL.findIndex((migration) => migration.version === VERSION);
    const previous = ALL[at - 1];
    expect(previous).toBeDefined();
    const run = spawnSync(
      process.execPath,
      ['scripts/local/upgrade-drill.mjs', '--from', previous?.version ?? '', '--json'],
      { encoding: 'utf8', env: process.env },
    );
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const result: unknown = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '');
    expect(result).toMatchObject({
      ok: true,
      differences: [],
      applied: expect.arrayContaining([VERSION]),
    });
  }, 180_000);
});
