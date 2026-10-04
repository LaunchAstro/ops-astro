// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { derivedId, expireOnce, TRACE_WINDOW_DAYS } from '../../packages/core-runtime/src/index.ts';
import { asAgent, barrier, codeOf, handbackBody, liveWork } from './schedules-harness.ts';
import { age, batchesOf } from './aw-13-retention-world.ts';
import { drain, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';

useAw13World('retention_step_back_confirmed');

// eslint-disable-next-line max-lines-per-function -- one schedule: a delete held, a fresh and an old-stamped event written, another pass, then released
it("a retention rewind must not resurrect another pass's confirmed expired trace", async () => {
  const works = [
    await liveWork(t.alpha, 'rewind selected run', 1000),
    await liveWork(t.alpha, 'other expired run', 1000),
  ].toSorted((left, right) =>
    String(left.picked['runId']).localeCompare(String(right.picked['runId'])),
  );
  const [selected, other] = works;
  if (!selected || !other) throw new Error('two runs are required');
  const selectedRun = String(selected.picked['runId']);
  const otherRun = String(other.picked['runId']);
  const selectedTrace = derivedId(TRACE_KEY, ['trace', t.alpha.business, selectedRun], 32);
  const otherTrace = derivedId(TRACE_KEY, ['trace', t.alpha.business, otherRun], 32);
  await drain(t.alpha);
  await age(selectedRun, TRACE_WINDOW_DAYS + 1);
  await age(otherRun, TRACE_WINDOW_DAYS + 1);

  const atDelete = barrier();
  const releaseDelete = barrier();
  const slow = expireOnce(
    t.alpha.db.app,
    t.alpha.business,
    TRACE_KEY,
    {
      expire: async (ids) => {
        expect(ids).toEqual([selectedTrace]);
        atDelete.release();
        await releaseDelete.held;
        return await t.target.expiry.expire(ids);
      },
      present: t.target.expiry.present,
    },
    { page: 1 },
  );
  try {
    await Promise.race([
      atDelete.held,
      slow.then(() => {
        throw new Error('no run was selected');
      }),
    ]);
    expect(
      codeOf(
        await asAgent(
          t.alpha,
          handbackBody(selected.picked),
          String(selected.picked['credential']),
        ),
      ),
    ).toBe('applied');
    // Model a transaction begun before the window that obtains its xid and
    // writes after the fresh event. The timestamp is aged, as in age().
    await t.alpha.db.app.withBusiness(t.alpha.business, async (tx) => {
      await tx.query(
        `insert into public.run_events
           (business_id, id, run_id, task_id, position, kind, lease_id, attempt_id, actor_id, detail, created_at)
         select business_id, gen_random_uuid(), run_id, task_id, position + 1,
                kind, lease_id, attempt_id, actor_id, '{}'::jsonb, created_at
           from public.run_events where business_id = $1 and run_id = $2
          order by position desc limit 1`,
        [tx.businessId, otherRun],
      );
    });
    await drain(t.alpha);
    await expireOnce(t.alpha.db.app, t.alpha.business, TRACE_KEY, t.target.expiry);
    expect((await batchesOf(t.alpha)).flatMap((batch) => batch.expired_run_ids)).toContain(
      otherRun,
    );
    expect(t.target.stored.has(otherTrace)).toBe(false);
  } finally {
    releaseDelete.release();
    await slow;
  }
  await drain(t.alpha);
  expect(t.target.stored.has(selectedTrace), 'the fresh selected run is restored').toBe(true);
  await expireOnce(t.alpha.db.app, t.alpha.business, TRACE_KEY, t.target.expiry);
  expect(
    t.target.stored.has(otherTrace),
    'a confirmed expired run must stay deleted after rewind and another retention pass',
  ).toBe(false);
});
