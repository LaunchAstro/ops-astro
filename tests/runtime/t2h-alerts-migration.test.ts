// SPDX-License-Identifier: AGPL-3.0-only
//
// T2h, migration 0034: the `alerts` table. On a fresh database and on one
// seeded at 0033 then upgraded: rows unchanged and the same catalogue. As the
// application role an alert is written once and never changed: a second alert
// for the same transition, an update and a delete are refused, and so is an
// alert in another business's name or on another business's task. No trigger
// or constraint is added on the gate, gate-decision or proposal tables (spike
// RN-12), and the worker holds nothing on the table.

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
} from '../../packages/core-records/src/tenancy/migrate.ts';
import { buildFixture, type RuntimeFixture } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/t2h-alerts-migration: DATABASE_URL is unset, so nothing below ran.');
}

const onDisk = readMigrations('migrations');
const THROUGH_0033 = (version: string): boolean => version.slice(0, 4) <= '0033';
const GATE_ENGINE = ['gates', 'gate_decisions', 'proposal_lineages', 'proposal_versions'];

/** Every constraint and trigger on the gate engine's tables, and on `alerts`. */
async function catalogue(db: EmptyDatabase): Promise<unknown> {
  return await db.admin.execute(
    `select conrelid::regclass::text as tab, conname as name, pg_get_constraintdef(oid) as def
       from pg_constraint
      where conrelid::regclass::text = any($1::text[])
     union all
     select tgrelid::regclass::text, tgname, pg_get_triggerdef(oid)
       from pg_trigger
      where not tgisinternal and tgrelid::regclass::text = any($1::text[])
      order by 1, 2`,
    [[...GATE_ENGINE, 'alerts']],
  );
}

async function gateEngine(db: EmptyDatabase): Promise<unknown> {
  const all = (await catalogue(db)) as readonly { readonly tab: string }[];
  return all.filter((row) => row.tab !== 'alerts');
}

/** The rows the upgrade must leave as they were. */
async function dump(db: EmptyDatabase): Promise<unknown> {
  return await db.admin.execute(
    `select (select count(*) from public.records)::text as records,
            (select count(*) from public.gates)::text as gates`,
  );
}

describe.skipIf(serverUrl === undefined)('0034 the alert record', () => {
  let fresh: EmptyDatabase;
  let upgraded: EmptyDatabase;
  let fixture: RuntimeFixture;
  let other: RuntimeFixture;
  let gateBefore: unknown;
  let seededBefore: unknown;

  beforeAll(async () => {
    fresh = await createEmptyDatabase({ part: 't2hmigfresh' });
    await applyMigrations(fresh.admin, onDisk);
    fixture = await buildFixture(fresh.app, 't2h-mig');
    other = await buildFixture(fresh.app, 't2h-mig-other');

    upgraded = await createEmptyDatabase({ part: 't2hmigup' });
    await applyMigrations(
      upgraded.admin,
      onDisk.filter((m) => THROUGH_0033(m.version)),
    );
    await buildFixture(upgraded.app, 't2h-seed');
    gateBefore = await gateEngine(upgraded);
    seededBefore = await dump(upgraded);
    await upgraded.closeSessions();
    await migrate(upgraded.admin, 'migrations');
  }, 180_000);

  afterAll(async () => {
    await fresh?.drop();
    await upgraded?.drop();
  });

  const insert = (
    business: string,
    taskId: string,
    fields: { kind?: string; waitingReason?: string | null; causeId?: string } = {},
  ) =>
    fresh.app.withBusiness(fixture.businessId, async (tx) => {
      await tx.query(
        `insert into public.alerts (business_id, id, task_id, kind, waiting_reason, cause_id)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          business,
          randomUUID(),
          taskId,
          fields.kind ?? 'settled',
          fields.waitingReason ?? null,
          fields.causeId ?? randomUUID(),
        ],
      );
    });

  it('rewrites no row, reads the same catalogue fresh and upgraded, and adds nothing to the gate engine’s tables', async () => {
    expect(await dump(upgraded)).toStrictEqual(seededBefore);
    expect(await catalogue(upgraded)).toStrictEqual(await catalogue(fresh));
    expect(await gateEngine(upgraded)).toStrictEqual(gateBefore);
  });

  it('writes one alert per transition, as the application role', async () => {
    const causeId = randomUUID();
    await insert(fixture.businessId, fixture.taskId, { causeId });
    await expect(insert(fixture.businessId, fixture.taskId, { causeId })).rejects.toMatchObject({
      constraint_name: 'alerts_one_per_transition',
    });
  });

  it.each([
    ['an unknown kind', { kind: 'progress' }, 'alerts_kind_known'],
    ['a wait with no reason', { kind: 'awaiting_person' }, 'alerts_reason_only_when_waiting'],
    [
      'a reason on an alert that is not a wait',
      { kind: 'settled', waitingReason: 'needs_approval' },
      'alerts_reason_only_when_waiting',
    ],
    [
      'an unknown waiting reason',
      { kind: 'awaiting_person', waitingReason: 'lunch' },
      'alerts_waiting_reason_known',
    ],
  ] as const)('refuses %s', async (_label, fields, constraint) => {
    await expect(insert(fixture.businessId, fixture.taskId, fields)).rejects.toMatchObject({
      constraint_name: constraint,
    });
  });

  it('refuses an alert in another business’s name, and one on another business’s task', async () => {
    await expect(insert(other.businessId, other.taskId)).rejects.toMatchObject({ code: '42501' });
    await expect(insert(fixture.businessId, other.taskId)).rejects.toMatchObject({
      constraint_name: 'alerts_task_fkey',
    });
  });

  it.each([
    ['update', `update public.alerts set kind = 'failed'`],
    ['delete', 'delete from public.alerts'],
  ])('refuses an %s: an alert is a record of what happened', async (_label, sql) => {
    await expect(
      fresh.app.withBusiness(fixture.businessId, async (tx) => {
        await tx.query(sql);
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('T2 worker role: the worker holds nothing on alerts', async () => {
    const holds = await fresh.admin.execute<{ readonly any: boolean }>(
      `select bool_or(has_table_privilege('ops_astro_worker', 'public.alerts', p)) as any
         from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p`,
    );
    expect(holds[0]?.any).toBe(false);
  });
});
