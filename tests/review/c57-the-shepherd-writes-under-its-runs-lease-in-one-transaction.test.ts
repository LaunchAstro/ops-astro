// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- each lease refusal and the race read top to bottom */
//
// C57 (#2017): the shepherd writes only under its occurrence's run's live lease, held by the
// worker presenting it at its current fence, with the activation on and its standing approval
// unrevoked; and its comment, items, send row and audit row are written in the caller's one
// transaction, so a retried occurrence writes nothing twice and a failure after the comment
// leaves nothing behind.

import { describe, expect, it } from 'vitest';
import { runReviewShepherd } from '../../packages/core-commands/src/index.ts';
import {
  anotherWorker,
  footprint,
  noDatabase,
  on,
  ownPool,
  raisedOf,
  revokeStanding,
  runOf,
  scene,
  shepherd,
  turnOff,
  useShepherdWorld,
  w,
  type Run,
} from './shepherd-world.ts';

useShepherdWorld('c57lease');

/** Each refusal answers its code and leaves the business's shepherd footprint as it was. */
async function refusedWithNothing(
  run: Pick<Run, 'side' | 'occurrenceId' | 'lease'>,
  review: string,
  code: string,
): Promise<void> {
  const before = await footprint();
  expect(await shepherd(run, review)).toStrictEqual({ kind: 'refused', code });
  expect(await footprint()).toStrictEqual(before);
}

/** Statements of this database waiting on a lock. */
const waitingOnLocks = async (): Promise<number> =>
  Number(
    (
      await w.db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
      )
    )[0]?.n,
  );

describe.skipIf(noDatabase)('C57 the shepherd writes under its lease in one transaction', () => {
  it('C57 the shepherd runs under its lease and writes in the same transaction as its cause: an expired lease is refused', async () => {
    const s = await scene();
    const run = await runOf();
    await w.db.admin.execute(
      `update public.leases set expires_at = clock_timestamp() - interval '1 second' where id = $1`,
      [run.lease.leaseId],
    );
    await refusedWithNothing(run, s.review, 'LEASE_NOT_OWNED');
  });

  it('C57 the shepherd runs under its lease and writes in the same transaction as its cause: a wrong fence is refused', async () => {
    const s = await scene();
    const run = await runOf();
    await refusedWithNothing(
      { ...run, lease: { ...run.lease, fence: run.lease.fence + 1 } },
      s.review,
      'LEASE_NOT_OWNED',
    );
  });

  it('C57 the shepherd runs under its lease and writes in the same transaction as its cause: another holder is refused', async () => {
    const s = await scene();
    const run = await runOf();
    const other = await anotherWorker('alpha');
    await refusedWithNothing(
      { ...run, lease: { ...run.lease, workerActorId: other } },
      s.review,
      'LEASE_NOT_OWNED',
    );
  });

  it('C57 the shepherd runs under its lease and writes in the same transaction as its cause: a lease on another run is refused', async () => {
    const s = await scene();
    const run = await runOf();
    const elsewhere = await runOf();
    await refusedWithNothing({ ...run, lease: elsewhere.lease }, s.review, 'LEASE_NOT_OWNED');
  });

  it('C57 the shepherd runs under its lease and writes in the same transaction as its cause: a released lease is refused', async () => {
    const s = await scene();
    const run = await runOf();
    await w.db.admin.execute(
      `update public.leases set state = 'released', released_at = now() where id = $1`,
      [run.lease.leaseId],
    );
    await refusedWithNothing(run, s.review, 'LEASE_NOT_OWNED');
  });

  it('C57 the shepherd runs under its lease and writes in the same transaction as its cause: a revoked standing approval is refused', async () => {
    const s = await scene();
    const run = await runOf();
    await revokeStanding(run);
    await refusedWithNothing(run, s.review, 'APPROVAL_NOT_STANDING');
  });

  it('C57 the shepherd runs under its lease and writes in the same transaction as its cause: a disabled activation is refused', async () => {
    const s = await scene();
    const run = await runOf();
    await turnOff(run);
    await refusedWithNothing(run, s.review, 'APPROVAL_NOT_STANDING');
  });

  it('C57 the shepherd runs under its lease and writes in the same transaction as its cause: a replayed occurrence answers replayed and writes nothing new', async () => {
    const s = await scene();
    const run = await runOf();
    const first = raisedOf(await shepherd(run, s.review));
    expect(first.replayed).toBe(false);
    const after = await footprint();
    expect(after.audit).toBeGreaterThan(0);
    const again = raisedOf(await shepherd(run, s.review));
    expect(again).toMatchObject({
      replayed: true,
      sendId: first.sendId,
      commentId: first.commentId,
      digest: first.digest,
    });
    expect(await footprint()).toStrictEqual(after);
  });

  it('C57 the shepherd runs under its lease and writes in the same transaction as its cause: two runs on two connections leave one comment and one send', async () => {
    const s = await scene();
    const run = await runOf();
    const before = await footprint();
    // A third connection holds the review's row; both runs, each on a pool of its own, are let
    // go together once both wait on it.
    const holder = ownPool();
    const pools = [ownPool(), ownPool()];
    try {
      const answers = await holder.withBusiness(on('alpha').business, async (tx) => {
        await tx.query(
          'select id from public.reviews where business_id = $1 and id = $2 for update',
          [tx.businessId, s.review],
        );
        const racing = pools.map(
          async (database) =>
            await shepherd(run, s.review, { database }).then(
              (outcome) => ({ ok: true as const, outcome }),
              (error: unknown) => ({ ok: false as const, error: String(error) }),
            ),
        );
        const deadline = Date.now() + 15_000;
        // eslint-disable-next-line no-await-in-loop -- polling until both wait
        while ((await waitingOnLocks()) < 2) {
          if (Date.now() > deadline) throw new Error('the two runs never both waited');
          // eslint-disable-next-line no-await-in-loop -- polling until both wait
          await new Promise((resolve) => {
            setTimeout(resolve, 50);
          });
        }
        return racing;
      });
      const settled = await Promise.all(answers);
      const after = await footprint();
      expect(after.comments - before.comments).toBe(1);
      expect(after.sends - before.sends).toBe(1);
      expect(after.items - before.items).toBe(1);
      expect(after.audit - before.audit).toBe(1);
      const raised = settled.flatMap((answer) =>
        answer.ok && answer.outcome.kind === 'raised' ? [answer.outcome] : [],
      );
      // One first raise; the other answer is the same send replayed.
      expect(raised.filter((answer) => !answer.replayed)).toHaveLength(1);
      const [sent] = await w.db.admin.execute<{ readonly id: string }>(
        'select id from public.review_shepherd_sends where review_id = $1',
        [s.review],
      );
      for (const answer of raised) expect(answer.sendId).toBe(sent?.id);
      // Both runs answer the one send: neither throws, and the second is its replay.
      expect(
        settled.map((answer) => (answer.ok ? answer.outcome.kind : answer.error)),
      ).toStrictEqual(['raised', 'raised']);
      expect(raised.filter((answer) => answer.replayed)).toHaveLength(1);
    } finally {
      await holder.close();
      for (const database of pools) {
        // eslint-disable-next-line no-await-in-loop -- one pool after another
        await database.close();
      }
    }
  });

  it('C57 the shepherd runs under its lease and writes in the same transaction as its cause: a failure after the comment write leaves nothing', async () => {
    const s = await scene();
    const run = await runOf();
    const before = await footprint();
    // A thrown error after the shepherd answered, inside the same transaction.
    await expect(
      w.db.app.withBusiness(on('alpha').business, async (tx) => {
        const outcome = await runReviewShepherd(tx, {
          occurrenceId: run.occurrenceId,
          reviewId: s.review,
          lease: run.lease,
        });
        expect(outcome.kind).toBe('raised');
        throw new Error('forced failure after the raise');
      }),
    ).rejects.toThrow('forced failure after the raise');
    expect(await footprint()).toStrictEqual(before);

    // A database failure inside the command itself, after the comment and the send row: the
    // item's insert for this task is refused by a trigger, so the whole raise rolls back.
    const trigger = `c57_refuse_${s.task.replaceAll('-', '')}`;
    await w.db.admin.execute(
      `create function public.${trigger}() returns trigger language plpgsql as $$
       begin
         if new.subject_record_id = '${s.task}'::uuid then
           raise exception 'c57 forced item failure';
         end if;
         return new;
       end $$`,
    );
    await w.db.admin.execute(
      `create trigger ${trigger} before insert on public.inbox_items
         for each row execute function public.${trigger}()`,
    );
    try {
      await expect(shepherd(run, s.review)).rejects.toThrow(/c57 forced item failure/u);
    } finally {
      await w.db.admin.execute(`drop trigger ${trigger} on public.inbox_items`);
      await w.db.admin.execute(`drop function public.${trigger}()`);
    }
    expect(await footprint()).toStrictEqual(before);
    const [records] = await w.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.records
        where business_id = $1 and data ->> 'task' = $2 and data ->> 'source' = 'shepherd'`,
      [on('alpha').business, s.task],
    );
    expect(records?.n).toBe('0');

    // With the trigger gone, the same occurrence raises once, as if never tried.
    const raised = raisedOf(await shepherd(run, s.review));
    expect(raised.replayed).toBe(false);
  });
});
