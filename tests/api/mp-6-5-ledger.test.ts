// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-5, the token ledger's figures on the task read, through the real
// boundary and a fresh Postgres. The allowance is the task's envelope, and
// what it was built from is the cap it draws on and the approval that opened
// it; spent and held are the envelope's own; the per-run rows are the
// reservations, each naming its envelope, and they add up to it. The stored
// rows, read with the admin role, are the oracle. Reading it adds no audit
// event beyond the read's own.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { Controls } from './controls-fixture.ts';
import { checksWorld, pickedUpOn, type PickedUp } from './mp-6-1-checks-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Envelope {
  readonly id: string;
  readonly state: string;
  readonly maximumMinor: number;
  readonly heldMinor: number;
  readonly actualMinor: number;
  readonly currency: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly openedBy: { readonly versionId: string } | null;
  readonly cap: { readonly key: string; readonly limitMinor: number; readonly currency: string };
}

interface Reservation {
  readonly id: string;
  readonly envelopeId: string;
  readonly runId: string;
  readonly state: string;
  readonly heldMinor: number;
  readonly actualMinor: number | null;
}

interface Read {
  readonly ledger: { readonly envelopes: readonly Envelope[]; readonly stops: readonly unknown[] };
  readonly proposals: readonly { readonly reservations: readonly Reservation[] }[];
}

// eslint-disable-next-line max-lines-per-function -- one world, each figure on it
describe.skipIf(serverUrl === undefined)('MP-6-5 token ledger', () => {
  let c: Controls;
  let work: PickedUp;

  beforeAll(async () => {
    ({ c } = await checksWorld('mp_6_5_ledger'));
    work = await pickedUpOn(c, 'ledger_work');
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  async function taskRead(taskId: string): Promise<Read> {
    const read = await c.asPerson('task.read', { recordId: taskId });
    expect(read.status).toBe(200);
    return read.body['task'] as unknown as Read;
  }

  const stored = async (taskId: string) =>
    await c.fixture.db.admin.execute<Record<string, string | null>>(
      `select e.id, e.state, e.maximum_minor::text as maximum_minor,
              e.held_minor::text as held_minor, e.actual_minor::text as actual_minor,
              e.currency, cap.key as cap_key, cap.limit_minor::text as cap_limit,
              cap.currency as cap_currency,
              (select r.version_id from public.reservations r
                where r.business_id = e.business_id and r.envelope_id = e.id
                order by r.created_at, r.id limit 1) as opened_by
         from public.task_envelopes e
         join public.budget_caps cap on cap.business_id = e.business_id and cap.id = e.cap_id
        where e.task_id = $1`,
      [taskId],
    );

  it('MP-6-5 allowance composition: the envelope, the cap it draws on and the approval that opened it', async () => {
    const [envelope] = (await taskRead(work.taskId)).ledger.envelopes;
    const [row] = await stored(work.taskId);
    expect(envelope).toBeDefined();
    expect(row).toBeDefined();
    expect(envelope?.id).toBe(row?.['id']);
    expect(envelope?.state).toBe('open');
    expect(envelope?.maximumMinor).toBe(Number(row?.['maximum_minor']));
    expect(envelope?.currency).toBe(row?.['currency']);
    expect(envelope?.cap).toStrictEqual({
      key: row?.['cap_key'],
      limitMinor: Number(row?.['cap_limit']),
      currency: row?.['cap_currency'],
    });
    expect(envelope?.openedBy).toStrictEqual({ versionId: work.versionId });
    expect(envelope?.closedAt).toBeNull();
  });

  it('MP-6-5 per-run rows match the ledger: each reservation names its envelope and they add up to it', async () => {
    const read = await taskRead(work.taskId);
    const [envelope] = read.ledger.envelopes;
    const [row] = await stored(work.taskId);
    const rows = read.proposals.flatMap((proposal) => proposal.reservations);
    expect(rows.length).toBeGreaterThan(0);
    for (const reservation of rows) expect(reservation.envelopeId).toBe(envelope?.id);
    const held = rows
      .filter((reservation) => reservation.state === 'held' || reservation.state === 'quarantined')
      .reduce((sum, reservation) => sum + reservation.heldMinor, 0);
    const actual = rows.reduce((sum, reservation) => sum + (reservation.actualMinor ?? 0), 0);
    expect(envelope?.heldMinor).toBe(Number(row?.['held_minor']));
    expect(envelope?.actualMinor).toBe(Number(row?.['actual_minor']));
    expect(held).toBe(envelope?.heldMinor);
    expect(actual).toBe(envelope?.actualMinor);
  });

  it('MP-6-5 per-run rows match the ledger: each row names the run it holds for', async () => {
    const read = await taskRead(work.taskId);
    const rows = read.proposals.flatMap((proposal) => proposal.reservations);
    const runs = await c.fixture.db.admin.execute<{ id: string; run_id: string }>(
      `select r.id, r.run_id from public.reservations r
         join public.planned_runs run on run.business_id = r.business_id and run.id = r.run_id
         join public.proposal_lineages lin on lin.business_id = run.business_id and lin.id = run.lineage_id
        where lin.task_id = $1`,
      [work.taskId],
    );
    expect(runs.length).toBe(rows.length);
    for (const run of runs) {
      expect(rows.find((reservation) => reservation.id === run.id)?.runId).toBe(run.run_id);
    }
  });

  it('MP-6-5 per-run rows match the ledger: a task never approved has no envelope, and says so', async () => {
    const bare = await c.createTask('never approved');
    const read = await taskRead(bare.id);
    expect(read.ledger).toStrictEqual({ envelopes: [], stops: [] });
  });

  it('MP-6-5 no audit event: the ledger adds no event beyond the read’s own', async () => {
    const since = async (): Promise<readonly string[]> =>
      (
        await c.fixture.db.admin.execute<{ readonly command: string }>(
          `select command from public.audit_events order by business_id, seq`,
          [],
        )
      ).map((row) => row.command);
    const before = await since();
    await taskRead(work.taskId);
    await taskRead(work.taskId);
    const after = await since();
    expect(after.slice(before.length)).toStrictEqual(['task.read', 'task.read']);
  });
});
