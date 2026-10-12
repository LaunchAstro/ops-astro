// SPDX-License-Identifier: AGPL-3.0-only
//
// An occurrence's run against writers on other connections. The origin
// trigger reads the occurrence's outcome and its activation's definition at the
// end of the insert, after any wait the insert's keys make; neither fact is one
// the application role can change, so a writer of the activation changes
// nothing it judges and the insert does not wait for it. One run per
// occurrence is the unique index's. Each schedule holds one writer open on its
// own connection, sees the second parked in `pg_stat_activity` where it parks,
// then ends the first. A crash or a lost response is a relay cut before or
// after the commit.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { connect, type TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { cutTransaction } from '../support/cut-transaction.ts';
import {
  authorityFor,
  noDatabase,
  occurrence,
  useOccurrenceWorld,
  w,
} from './occurrence-run-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useOccurrenceWorld('originrace');

/** One run on `occurrenceId` through the occurrence role, as the dispatch's write takes it. */
const insertRun = async (tx: TenantQuery, occurrenceId: string, id = randomUUID()) => {
  await tx.query(`select set_config('role', 'ops_astro_occurrence', true)`);
  await tx.query(
    `insert into public.planned_runs (business_id, id, task_id, origin_occurrence_id,
       origin_definition_id, origin_approved_by_actor_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      w.s.business,
      id,
      w.work.taskId,
      occurrenceId,
      authorityFor(w.s).definitionId,
      w.s.decider.actorId,
    ],
  );
  return id;
};

const runsOn = async (occurrenceId: string): Promise<readonly string[]> =>
  (
    await w.s.db.admin.execute<{ readonly id: string }>(
      `select id::text from public.planned_runs where origin_occurrence_id = $1`,
      [occurrenceId],
    )
  ).map((row) => row.id);

/**
 * `first` is held open on its own connection; a run on `occurrenceId` is seen
 * parked behind it (a lock wait in `planned_runs`), or answers without one when
 * `parks` is false; then `first` ends `ending`.
 */
async function runBehind(
  first: (tx: TenantQuery) => Promise<unknown>,
  occurrenceId: string,
  ending: 'commit' | 'rollback',
  parks = true,
) {
  const holder = await hold(w.s.db.appUrl, w.s.business, first, ending);
  const racer = connect(w.s.db.appUrl, { source: 'racer' });
  try {
    const id = randomUUID();
    // Settled as it starts, so its refusal is never an unhandled rejection.
    const racing = Promise.allSettled([
      racer.withBusiness(w.s.business, async (tx) => await insertRun(tx, occurrenceId, id)),
    ]);
    if (parks) await waitingOn(w.s.db.admin, 'transactionid', 'planned_runs');
    const [early] = parks ? [undefined] : await racing;
    await holder.letGo();
    const [raced] = early === undefined ? await racing : [early];
    return { id, raced };
  } finally {
    await holder.letGo().catch(() => null);
    await racer.close();
  }
}

it('two runs on one approved occurrence at once leave one run', async () => {
  const origin = await occurrence(w.s);
  let firstId = '';
  const { raced } = await runBehind(
    async (tx) => {
      firstId = await insertRun(tx, origin);
    },
    origin,
    'commit',
  );
  expect(raced).toMatchObject({ status: 'rejected', reason: { code: '23505' } });
  expect(await runsOn(origin)).toStrictEqual([firstId]);
});

it('a run behind one on the same occurrence that rolled back stands', async () => {
  const origin = await occurrence(w.s);
  const { id, raced } = await runBehind(
    async (tx) => await insertRun(tx, origin),
    origin,
    'rollback',
  );
  expect(raced.status).toBe('fulfilled');
  expect(await runsOn(origin)).toStrictEqual([id]);
});

it('a run inserted while its activation is switched on another connection is judged without waiting', async () => {
  const origin = await occurrence(w.s);
  const [found] = await w.s.db.admin.execute<{ readonly activation: string }>(
    `select activation_id::text as activation from public.activation_occurrences where id = $1`,
    [origin],
  );
  const switchOver = async (tx: TenantQuery) => {
    const switched = await tx.query(
      `update public.activations set enabled = not enabled, revision = revision + 1,
              changed_by_actor_id = $2, changed_at = now()
        where id = $1 returning id`,
      [found?.activation, w.s.decider.actorId],
    );
    // The activation's row is locked by a real change, not by a write of nothing.
    if (switched.length !== 1) throw new Error('the activation was not switched');
  };
  const { id, raced } = await runBehind(switchOver, origin, 'rollback', false);
  expect(raced.status).toBe('fulfilled');
  expect(await runsOn(origin)).toStrictEqual([id]);
});

it('a run naming an occurrence not yet committed on another connection is refused, and its retry stands after', async () => {
  const origin = randomUUID();
  const approved = await occurrence(w.s);
  const write = async (tx: TenantQuery) =>
    await tx.query(
      `insert into public.activation_occurrences
         (business_id, id, activation_id, version_id, event_id, outcome, approval_id)
       select business_id, $2, activation_id, version_id, $3, outcome, approval_id
         from public.activation_occurrences where id = $1`,
      [approved, origin, `race-${origin}`],
    );
  const holder = await hold(w.s.db.appUrl, w.s.business, write);
  try {
    await expect(
      w.s.db.app.withBusiness(w.s.business, async (tx) => await insertRun(tx, origin)),
    ).rejects.toMatchObject({ code: '23503' });
  } finally {
    await holder.letGo();
  }
  const id = await w.s.db.app.withBusiness(w.s.business, async (tx) => await insertRun(tx, origin));
  expect(await runsOn(origin)).toStrictEqual([id]);
});

it('a run cut before its commit leaves no run, and its retry stands once', async () => {
  const origin = await occurrence(w.s);
  const cut = await cutTransaction(w.s.db.appUrl, w.s.business, 'before-commit', async (tx) => {
    await insertRun(tx, origin);
  });
  expect(cut.status).toBe('rejected');
  expect(await runsOn(origin)).toStrictEqual([]);
  const id = await w.s.db.app.withBusiness(w.s.business, async (tx) => await insertRun(tx, origin));
  expect(await runsOn(origin)).toStrictEqual([id]);
});

it('a run whose commit answer is lost stands once, and its retry is refused', async () => {
  const origin = await occurrence(w.s);
  const id = randomUUID();
  const cut = await cutTransaction(w.s.db.appUrl, w.s.business, 'after-commit', async (tx) => {
    await insertRun(tx, origin, id);
  });
  expect(cut.status).toBe('rejected');
  await expect(
    w.s.db.app.withBusiness(w.s.business, async (tx) => await insertRun(tx, origin)),
  ).rejects.toMatchObject({ code: '23505' });
  expect(await runsOn(origin)).toStrictEqual([id]);
});
