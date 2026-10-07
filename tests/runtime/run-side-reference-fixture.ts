// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFreshDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  applyMigrations,
  readMigrations,
  type Migration,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import {
  createTask,
  freshPurpose,
  openSchedules,
  propose,
  seedSchedules,
} from './schedules-harness.ts';
import {
  s,
  own,
  other,
  child,
  seedRunRows,
  setSchedules,
  type Row,
} from './run-side-rows-fixture.ts';

export { s, own, other };
export const VERSION = '20261007053014_run_reference_scopes';
export const ALL: readonly Migration[] = readMigrations('migrations');
export const noDatabase: boolean = databaseUrlFromEnvironment() === undefined;
export const REFERENCES = [
  ['attempts', 'step_id'],
  ['attempts', 'lease_id'],
  ['attempts', 'reservation_id'],
  ['attempts', 'version_id'],
  ['attempts', 'envelope_id'],
  ['handback_reports', 'lease_id'],
  ['handback_reports', 'reservation_id'],
  ['run_events', 'lease_id'],
  ['run_events', 'attempt_id'],
  ['outage_runs', 'attempt_id'],
  ['model_calls', 'conversation_id'],
  ['model_calls', 'outcome_person_id'],
] as const;
let attempt: Row;
let otherReservation: Row;
let outageId: string;
let ownConversation: string;
let foreignConversation: string;
let foreignPerson: string;
let position = 100;

async function seedAttempt(): Promise<Row> {
  const task = await createTask(s, 'Unclaimed attempt');
  const proposal = await propose(s, task, { purpose: freshPurpose() });
  const reservation = randomUUID();
  const rows = await s.db.admin.execute<{ envelope_id: string }>(
    'select envelope_id from public.attempts where id = $1',
    [own.attempt_id],
  );
  const envelope = rows[0]?.envelope_id;
  if (envelope === undefined) throw new Error('missing envelope');
  await s.db.app.withBusiness(s.business, async (tx) => {
    await tx.query(
      `insert into public.reservations
      (business_id, id, envelope_id, version_id, run_id, held_minor)
      values ($1, $2, $3, $4, $5, 1)`,
      [s.business, reservation, envelope, proposal['versionId'], proposal['runId']],
    );
  });
  return {
    run_id: String(proposal['runId']),
    step_id: String(proposal['stepId']),
    version_id: String(proposal['versionId']),
    reservation_id: reservation,
    envelope_id: envelope,
    lease_id: null,
    price_book: 'synthetic/local@1',
    estimated_minor: 1,
  };
}

async function seedReferences(): Promise<void> {
  await seedRunRows();
  attempt = await seedAttempt();
  otherReservation = await seedAttempt();
  const foreign = await seedSchedules(s.db, 'foreignrefs', 1_000_000);
  foreignPerson = foreign.decider.personId;
  ownConversation = randomUUID();
  foreignConversation = randomUUID();
  await s.db.admin.execute(
    `insert into public.conversations
    (business_id, id, owner_actor_id, owner_person_id, title) values
    ($1, $2, $3, $4, 'Own conversation'), ($5, $6, $7, $8, 'Other conversation')`,
    [
      s.business,
      ownConversation,
      s.decider.actorId,
      s.decider.personId,
      foreign.business,
      foreignConversation,
      foreign.decider.actorId,
      foreignPerson,
    ],
  );
  outageId = randomUUID();
  await s.db.app.withBusiness(s.business, async (tx) => {
    await tx.query(
      `insert into public.outage_reports (business_id, id, cause)
      values ($1, $2, 'worker_lost')`,
      [s.business, outageId],
    );
  });
}

export function useReferences(): void {
  beforeAll(async () => {
    if (noDatabase) return;
    setSchedules(await openSchedules('references', 1_000_000));
    await seedReferences();
  }, 60_000);
  afterAll(async () => {
    await s?.db.drop();
  });
}

export function useUpgrade(): void {
  let directory: string;
  beforeAll(() => {
    process.env['GATE_SIGNING_KEY_ID'] = 'test/reference-upgrade@1';
    process.env['GATE_SIGNING_SECRET'] = randomUUID();
    directory = mkdtempSync(join(tmpdir(), 'reference-before-'));
    for (const file of readdirSync('migrations')) {
      if (file.endsWith('.sql') && file < `${VERSION}.sql`) {
        copyFileSync(join('migrations', file), join(directory, file));
      }
    }
  });
  beforeEach(async () => {
    if (noDatabase) return;
    setSchedules(
      await seedSchedules(
        await createFreshDatabase({
          part: 'referenceupgrade',
          migrationsDirectory: directory,
        }),
        'referenceupgrade',
        1_000_000,
      ),
    );
    await seedReferences();
  }, 60_000);
  afterEach(async () => {
    await s?.db.drop();
  });
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

export async function refreshAttempt(): Promise<void> {
  attempt = await seedAttempt();
}

export function rowFor(table: string): Row {
  if (table === 'attempts') return { ...attempt };
  if (table === 'handback_reports')
    return {
      run_id: own.run_id,
      lease_id: own.lease_id,
      reservation_id: own.reservation_id,
      fence: 1,
      disposition: 'retained',
      outcome: 'completed',
      refusal_code: 'LEASE_NOT_OWNED',
      report: '{}',
    };
  if (table === 'run_events')
    return {
      run_id: own.run_id,
      task_id: own.task_id,
      lease_id: own.lease_id,
      attempt_id: own.attempt_id,
      actor_id: s.agentActorId,
      position: ++position,
      kind: 'claimed',
      detail: '{}',
    };
  if (table === 'outage_runs')
    return {
      run_id: own.run_id,
      task_id: own.task_id,
      attempt_id: own.attempt_id,
      outage_id: outageId,
      reactivated: false,
    };
  return {
    ...child('model_calls'),
    outcome: 'nothing_happened',
    outcome_person_id: s.decider.personId,
  };
}

export async function hostileRow(table: string, column: string): Promise<Row> {
  if (column === 'conversation_id') return conversationRow(foreignConversation);
  if (column === 'outcome_person_id') return { ...rowFor(table), [column]: foreignPerson };
  if (table === 'attempts' && column === 'reservation_id') {
    return { ...rowFor(table), reservation_id: otherReservation['reservation_id'] ?? null };
  }
  const rows = await s.db.admin.execute<Row>(
    'select a.*, a.id as attempt_id from public.attempts a where id = $1',
    [other.attempt_id],
  );
  const value = rows[0]?.[column];
  if (value === undefined) throw new Error('missing reference');
  return { ...rowFor(table), [column]: value };
}

export function conversationRow(id: string = ownConversation): Row {
  return {
    conversation_id: id,
    operation_key: 'test.compose',
    route_key: 'test',
    route_reach: 'local',
    credential_kind: 'replay',
    state: 'reserved',
    reserved_minor: 0,
  };
}

const rolledBack = new Error('fixture insert rolled back');
export async function insertReference(table: string, row: Row, persist = false): Promise<void> {
  const entries = Object.entries({
    business_id: s.business,
    ...(table === 'outage_runs' ? {} : { id: randomUUID() }),
    ...row,
  });
  try {
    await s.db.app.withBusiness(s.business, async (tx) => {
      await tx.query(
        `insert into public.${table} (${entries.map(([key]) => key).join(', ')})
        values (${entries.map(([key], i) => `$${i + 1}${key === 'detail' || key === 'report' ? '::text::jsonb' : ''}`).join(', ')})`,
        entries.map(([, value]) => value),
      );
      if (!persist) throw rolledBack;
    });
  } catch (error) {
    if (error !== rolledBack) throw error;
  }
}

export async function snapshot(): Promise<unknown> {
  const tables = ['attempts', 'handback_reports', 'run_events', 'outage_runs', 'model_calls'];
  return await s.db.admin.execute(
    'select * from (' +
      tables
        .map(
          (table) => `select '${table}' as table_name, to_jsonb(r) as row from public.${table} r`,
        )
        .join(' union all ') +
      ') rows order by table_name, row::text',
  );
}

export async function refusedUpgrade(reference: string): Promise<void> {
  const before = await snapshot();
  const ledger = await s.db.admin.execute('select * from ops.schema_migrations order by version');
  await s.db.closeSessions();
  await expect(applyMigrations(s.db.admin, ALL)).rejects.toMatchObject({
    cause: {
      code: '23503',
      message: `run-bound references: ${reference} contains orphaned or cross-scope rows`,
    },
  });
  expect(await snapshot()).toEqual(before);
  expect(await s.db.admin.execute('select * from ops.schema_migrations order by version')).toEqual(
    ledger,
  );
  expect(
    await s.db.admin.execute(`select conname from pg_constraint
    where conname in ('model_calls_conversation_fkey', 'attempts_run_in_version',
      'reservations_run_envelope_key')`),
  ).toEqual([]);
}
