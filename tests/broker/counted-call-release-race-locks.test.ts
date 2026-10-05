// SPDX-License-Identifier: AGPL-3.0-only
//
// catalogue #756, #939 (SEC-756S): the two locks that keep a top-up or end and
// the model-call sweep from stranding a counted call, each pinned by its own
// interleaving on separate connections:
// - the count locks the unsent calls it read (`giveBackReleased`), so a sweep
//   while it holds them leaves the call for the next pass;
// - the sweep locks an unsent call's row before it reads "never counted"
//   (`releaseUnsent`), so a count that meets it there waits, then gives back.

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import { reserveModelCall, sweepModelCalls } from '../../packages/core-custody/src/index.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import { endAtBudgetStop, topUpAtBudgetStop } from '../../packages/core-runtime/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { liveWork, racer, rows, type Work } from '../runtime/schedules-harness.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import {
  broker,
  call,
  caller,
  noDatabase,
  requestFor,
  s,
  stepOf,
  useBrokerWorld,
  world,
} from './broker-world.ts';
import { calls, decider, envelopeActual, reservationOf, runOf } from './give-back-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('releaseracelocks');

beforeAll(async () => {
  if (noDatabase) return;
  await openBilling(s);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'decide', undefined, false, 'gate');
  });
}, 120_000);

/** 900 holds one call reserved at 500, never sent, and the next call stops the run. */
async function stoppedUnsent(): Promise<Work> {
  const work = await liveWork(s, `release race locks ${randomUUID()}`, 900);
  world.provider.mode('answer');
  await stepOf(work);
  const reserved = await s.db.app.withBusiness(
    s.business,
    async (tx) => await reserveModelCall(tx, caller(work), requestFor(work), broker),
  );
  expect(reserved.ok).toBe(true);
  expect(await call(work)).toMatchObject({ ok: false, code: 'BUDGET_UNAVAILABLE' });
  return work;
}

/** A transaction that stops once, after the first statement holding `marker`, until resumed. */
function pausedAfter(marker: string) {
  let reach: (() => void) | undefined;
  let resume: (() => void) | undefined;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const wrap = (tx: TenantQuery): TenantQuery => ({
    ...tx,
    query: async <Row>(sql: string, parameters?: readonly unknown[]) => {
      const result = await tx.query<Row>(sql, parameters);
      if (sql.includes(marker)) {
        reach?.();
        await gate;
      }
      return result;
    },
  });
  return { reached, resume: () => resume?.(), wrap };
}

type Answer = 'top-up' | 'end';

const answering = async (answer: Answer, tx: TenantQuery, work: Work) => {
  const request = decider(s, await runOf(work));
  return answer === 'top-up'
    ? await topUpAtBudgetStop(tx, { ...request, amountMinor: 1_000, currency: 'AUD' })
    : await endAtBudgetStop(tx, request);
};

const sweep = async (): Promise<void> => {
  await s.db.app.withBusiness(s.business, async (tx) => await sweepModelCalls(tx));
};

/** True once a statement holding `marker` waits on a lock, polled for up to five seconds. */
async function waitingOn(marker: string): Promise<boolean> {
  await expect
    .poll(
      async () => {
        const [row] = await rows<{ waiting: boolean }>(
          s,
          `select exists(select 1 from pg_stat_activity
                          where datname = current_database() and wait_event_type = 'Lock'
                            and query like $1) as waiting`,
          [`%${marker}%`],
        );
        return row?.waiting;
      },
      { timeout: 5_000 },
    )
    .toBe(true);
  return true;
}

/** The hold's own figure, as the administrator reads it. */
const holdOf = async (work: Work): Promise<number> => {
  const [row] = await rows<{ held: string }>(
    s,
    'select held_minor::text as held from public.reservations where id = $1',
    [reservationOf(work)],
  );
  return Number(row?.held);
};

for (const answer of ['top-up', 'end'] as const) {
  it(`a sweep while a ${answer} holds the unsent call's row leaves it to the next pass`, async () => {
    const work = await stoppedUnsent();
    const before = await envelopeActual(work);
    const other = racer(s);
    const paused = pausedAfter('order by id for update');
    const pending = other.withBusiness(
      s.business,
      async (tx) => await answering(answer, paused.wrap(tx), work),
    );
    try {
      await paused.reached;
      await sweep();
      expect(await calls(work), 'skipped: the count holds it').toMatchObject([
        { state: 'reserved' },
      ]);
      expect(await envelopeActual(work)).toBe(before + 500);
      paused.resume();
      expect(await pending).toMatchObject({ ok: true });
    } finally {
      paused.resume();
      await pending;
      await other.close();
    }
    await sweep();
    expect(await calls(work)).toMatchObject([{ state: 'released' }]);
    expect(await envelopeActual(work), 'given back once').toBe(before);
  });

  it(`a ${answer} that meets the sweep on the unsent call's row waits, then gives back what it counted`, async () => {
    const work = await stoppedUnsent();
    const before = await envelopeActual(work);
    const sweeper = racer(s);
    const paused = pausedAfter('for update of c skip locked');
    const sweeping = sweeper.withBusiness(
      s.business,
      async (tx) => await sweepModelCalls(paused.wrap(tx)),
    );
    try {
      await paused.reached;
      const pending = s.db.app.withBusiness(
        s.business,
        async (tx) => await answering(answer, tx, work),
      );
      expect(await waitingOn('order by id for update'), 'the count waits on the row').toBe(true);
      paused.resume();
      await sweeping;
      const answered = await pending;
      expect(await calls(work)).toMatchObject([{ state: 'released' }]);
      expect(await envelopeActual(work), 'given back by the count').toBe(before);
      // The figures the answer reports include what it gave back.
      expect(answered).toMatchObject(
        answer === 'end'
          ? { ok: true, value: { spentMinor: 0 } }
          : { ok: true, value: { heldMinor: await holdOf(work) } },
      );
    } finally {
      paused.resume();
      await sweeping;
      await sweeper.close();
    }
  });
}
