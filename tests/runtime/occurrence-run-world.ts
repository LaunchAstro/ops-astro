// SPDX-License-Identifier: AGPL-3.0-only
//
// The world for AW-01 J's two suites: a business with an active worker, a
// second business with its own, and an agent under a live delegation. The
// approval and version facts come through `ReadOccurrenceAuthority`, the port
// C52-A fills from its own rows under the activation lock (SL13); here a
// stand-in answers from the one occurrence it was built for, so the refusals
// are proved on the real write.

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import {
  startOccurrenceRun,
  type OccurrenceAuthority,
  type ReadOccurrenceAuthority,
} from '../../packages/core-commands/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  liveWork,
  openSchedules,
  scalar,
  seedSchedules,
  type Schedules,
  type Work,
} from './schedules-harness.ts';

export const noDatabase: boolean = databaseUrlFromEnvironment() === undefined;

export interface OccurrenceWorld {
  s: Schedules;
  bravo: Schedules;
  worker: string;
  bravoWorker: string;
  /** An agent acting under a live delegation minted by a pickup. */
  work: Work;
}

export const w = {} as OccurrenceWorld;

export const DIGEST: string = createHash('sha256').update('definition bytes').digest('hex');

export async function insertWorker(on: Schedules, active = true): Promise<string> {
  const id = randomUUID();
  await on.db.app.withBusiness(on.business, async (tx) => {
    await tx.query(
      `insert into public.actors (business_id, id, kind, active, deactivated_at)
       values ($1, $2, 'worker', $3, case when $3 then null else now() end)`,
      [on.business, id, active],
    );
  });
  return id;
}

export function useOccurrenceWorld(label: string): void {
  beforeAll(async () => {
    if (noDatabase) return;
    w.s = await openSchedules(label, 1_000_000);
    w.bravo = await seedSchedules(w.s.db, `${label}-bravo`, 1_000_000);
    w.worker = await insertWorker(w.s);
    w.bravoWorker = await insertWorker(w.bravo);
    w.work = await liveWork(w.s, `${label}-${randomUUID()}`, 2_000);
  }, 180_000);
  afterAll(async () => {
    await w.s?.db.drop();
  });
}

export function authorityFor(
  on: Schedules,
  overrides: Partial<OccurrenceAuthority> = {},
): OccurrenceAuthority {
  return {
    approvalId: randomUUID(),
    approvalState: 'standing',
    approverActorId: on.decider.actorId,
    definitionId: randomUUID(),
    definitionVersionId: randomUUID(),
    versionState: 'released',
    contentDigest: DIGEST,
    contentSize: 42,
    clientId: null,
    title: `nightly reconciliation ${randomUUID()}`,
    ...overrides,
  };
}

/** The stand-in for C52-A's read: one occurrence, its facts. */
export const readerFor =
  (occurrenceId: string, authority: OccurrenceAuthority | undefined): ReadOccurrenceAuthority =>
  async (_tx, asked) =>
    await Promise.resolve(asked === occurrenceId ? authority : undefined);

export async function start(
  on: Schedules,
  occurrenceId: string,
  authority: OccurrenceAuthority | undefined,
  workerActorId: string,
  database: Database = on.db.app,
): ReturnType<typeof startOccurrenceRun> {
  return await database.withBusiness(
    on.business,
    async (tx) =>
      await startOccurrenceRun(
        tx,
        { occurrenceId, workerActorId },
        readerFor(occurrenceId, authority),
      ),
  );
}

export const codeOf = (result: Awaited<ReturnType<typeof start>>): string =>
  result.ok ? 'applied' : result.refusal.code;

export interface Footprint {
  readonly runs: number;
  readonly records: number;
  readonly pins: number;
  readonly audit: number;
}

/** Everything an occurrence run writes, counted across every business. */
export async function footprint(): Promise<Footprint> {
  const count = async (table: string, where = 'true') =>
    await scalar(w.s, `select count(*)::text as n from public.${table} where ${where}`, []);
  return {
    runs: await count('planned_runs'),
    records: await count('records'),
    pins: await count('run_definition_pins'),
    audit: await count('audit_events', `command = 'occurrence.run_start'`),
  };
}
