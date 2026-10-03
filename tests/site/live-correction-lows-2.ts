// SPDX-License-Identifier: AGPL-3.0-only
//
// P26's re-bind review (round 2) of the live correction's records (C80): four
// more lows, each held on a real database in a world of its own, opened by
// round 1's `describeWorld` (`live-correction-lows.ts`) after round 1's is
// dropped, so its lease is live and its delegation not revoked.
//
//   1. Filing a correction locks the task's client.
//   2. The receipt write locks the lease and then its delegation, and judges
//      both expiries on the clock read after its locks. It runs last: it ends
//      the world's delegation.
//   3. A trashed task takes no correction.
//   4. The draft runner's cancel (`live-correction-lows-cancel.ts`), and
//      round 3's finding 2 there: a cancel during the read-back keeps the receipt.
//
// Registered through `tests/tenancy/restricted-calls.test.ts`, a named suite,
// which calls `describeLiveCorrectionLowsRoundTwo` after round 1.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  asPerson,
  awaitParked,
  barrier,
  codeOf,
  holdRows,
  racer,
  revisionOf,
  startedBefore,
  waitPast,
} from '../runtime/schedules-harness.ts';
import { revokeDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { recordObservedResult } from '../../packages/core-records/src/site/index.ts';
import {
  countOf,
  describeWorld,
  file,
  filed,
  lows,
  RECEIPTS,
  stateOf,
  taskOf,
} from './live-correction-lows.ts';
import {
  cancelDuringReadBack,
  findingFourAllowed,
  findingFourRefused,
  observedPublish,
} from './live-correction-lows-cancel.ts';

async function clientOf(taskId: string): Promise<string | null | undefined> {
  const rows = await lows().s.db.admin.execute<{ readonly client: string | null }>(
    'select uuid_7 as client from public.records where id = $1',
    [taskId],
  );
  return rows[0]?.client;
}

async function moveTo(taskId: string, client: string): Promise<string> {
  const { s } = lows();
  return codeOf(
    await asPerson(s, {
      command: 'task.set_party',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(s, taskId),
      fields: { client },
    }),
  );
}

function findingOne(): void {
  it('a task holding only a correction refuses task.set_party and keeps its client', async () => {
    const { s, clientA, clientB } = lows();
    const filedOn = await taskOf(s, clientA);
    expect(await file(filedOn, clientA)).toMatchObject({ taskId: filedOn, partyId: clientA });
    expect(await moveTo(filedOn, clientB)).toBe('CLIENT_LOCKED');
    expect(await clientOf(filedOn)).toBe(clientA);
    // The control: a task of the same client with nothing filed on it still moves.
    const empty = await taskOf(s, clientA);
    expect(await moveTo(empty, clientB)).toBe('applied');
    expect(await clientOf(empty)).toBe(clientB);
  });
}

function findingThree(): void {
  const OF_TASK = 'select count(*)::int as n from public.live_corrections where task_id = $1';

  it('a correction on a trashed task is refused and writes nothing', async () => {
    const { s, clientA } = lows();
    const trashed = await taskOf(s, clientA);
    const answer = await asPerson(s, {
      command: 'task.trash',
      operationId: randomUUID(),
      recordId: trashed,
      expectedRevision: await revisionOf(s, trashed),
    });
    expect(codeOf(answer)).toBe('applied');
    expect(await file(trashed, clientA)).toStrictEqual({
      ok: false,
      code: 'CORRECTION_PARTY_MISMATCH',
    });
    expect(await countOf(OF_TASK, trashed)).toBe(0);
  });
}

/** Each row's expiry, found from the world's lease (`$1`), for the harness's clock polls. */
const EXPIRES = {
  leases: 'select expires_at from public.leases where id = $1',
  delegations: `select d.expires_at from public.delegations d
                  join public.leases l on l.business_id = d.business_id and l.delegation_id = d.id
                 where l.id = $1`,
} as const;

const SET_EXPIRY = {
  leases: 'update public.leases set expires_at = $2::timestamptz where id = $1',
  delegations: `update public.delegations set expires_at = $2::timestamptz
                 where id = (select delegation_id from public.leases where id = $1)`,
} as const;

/** Run `test` with three seconds left on `table`'s row, on the database clock; then restore it. */
async function withThreeSeconds(
  table: keyof typeof EXPIRES,
  test: () => Promise<void>,
): Promise<void> {
  const { s, leaseId } = lows();
  const [kept] = await s.db.admin.execute<{ readonly at: string }>(
    `select expires_at::text as at from (${EXPIRES[table]}) e`,
    [leaseId],
  );
  const [soon] = await s.db.admin.execute<{ readonly at: string }>(
    `select (clock_timestamp() + interval '3 seconds')::text as at`,
  );
  await s.db.admin.execute(SET_EXPIRY[table], [leaseId, soon?.at]);
  try {
    await test();
  } finally {
    await s.db.admin.execute(SET_EXPIRY[table], [leaseId, kept?.at]);
  }
}

/**
 * The receipt write parked on the correction (held by another connection)
 * until `table`'s row is past its expiry on the database clock, then let go.
 */
async function writtenAcrossExpiry(table: keyof typeof EXPIRES, id: string): Promise<unknown> {
  const { s, leaseId } = lows();
  const writer = racer(s);
  const holder = await holdRows(s, 'live_corrections', [id]);
  try {
    const writing = writer.withBusiness(
      s.business,
      async (tx) => await recordObservedResult(tx, observedPublish(id, 'live')),
    );
    await awaitParked(s, 'live_corrections', 1);
    expect(await startedBefore(s, EXPIRES[table], leaseId)).toBe(true);
    await waitPast(s, EXPIRES[table], leaseId);
    await holder.release();
    return await writing;
  } finally {
    await holder.release().catch(() => null);
    await writer.close();
  }
}

/** The receipt write held open after its check while the delegation is revoked: which came first. */
async function revokedDuringReceipt(id: string): Promise<{ first: string; receipt: unknown }> {
  const { s, leaseId } = lows();
  const [lease] = await s.db.admin.execute<{ readonly delegation: string }>(
    'select delegation_id as delegation from public.leases where id = $1',
    [leaseId],
  );
  const [writer, revoker] = [racer(s), racer(s)];
  const [written, commit] = [barrier(), barrier()];
  let receipt: unknown;
  const writing = writer.withBusiness(s.business, async (tx) => {
    receipt = await recordObservedResult(tx, observedPublish(id, 'live'));
    written.release();
    await commit.held;
  });
  try {
    await Promise.race([written.held, writing]);
    const revoking = revoker.withBusiness(
      s.business,
      async (tx) => await revokeDelegation(tx, String(lease?.delegation)),
    );
    const first = await Promise.race([
      revoking.then(() => 'revoked while the receipt was open'),
      awaitParked(s, 'delegations', 1).then(() => 'the revocation waits on the receipt'),
    ]);
    commit.release();
    await writing;
    await revoking;
    return { first, receipt };
  } finally {
    commit.release();
    await writing.catch(() => null);
    await Promise.all([writer.close(), revoker.close()]);
  }
}

function findingTwo(): void {
  for (const table of ['leases', 'delegations'] as const) {
    it(`a ${table} row expiring while the receipt write waits on the correction refuses it`, async () => {
      const { id } = await filed('approved');
      let answer: unknown;
      await withThreeSeconds(table, async () => {
        answer = await writtenAcrossExpiry(table, id);
      });
      expect(answer).toStrictEqual({ ok: false, code: 'LEASE_NOT_OWNED' });
      expect([await stateOf(id), await countOf(RECEIPTS, id)]).toStrictEqual(['approved', 0]);
    }, 30_000);
  }

  it('a revocation waits for the receipt write that read its delegation live', async () => {
    const { id } = await filed('approved');
    const { first, receipt } = await revokedDuringReceipt(id);
    expect(first).toBe('the revocation waits on the receipt');
    expect(receipt).toMatchObject({ ok: true, state: 'live' });
    expect([await stateOf(id), await countOf(RECEIPTS, id)]).toStrictEqual(['live', 1]);
  }, 30_000);
}

/** Round 2's findings, each its own block over one world. */
export function describeLiveCorrectionLowsRoundTwo(): void {
  describeWorld('P26 lows round 2: the live correction records', 'p26lows2', () => {
    describe('finding 1: filing a correction locks the task’s client', findingOne);
    describe('finding 3: a trashed task takes no correction', findingThree);
    describe('finding 4: the runner’s cancel, allowed', findingFourAllowed);
    describe('finding 4: every other move to or from cancelled, refused', findingFourRefused);
    describe(
      'round 3 finding 2: a cancel during the read-back keeps the receipt',
      cancelDuringReadBack,
    );
    // Last: its revocation ends the world's delegation.
    describe('finding 2: the receipt write judges expiry after its locks', findingTwo);
  });
}
