// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { effectOperationId } from '../../packages/core-wire/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  asAgent,
  awaitParked,
  codeOf,
  holdRows,
  openSchedules,
  racer,
  type Schedules,
} from './schedules-harness.ts';
import { cq8World, PRICED, t2dHarness } from './t2d-harness.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'T2d settlement against a late effect and a wrong-client identity',
  () => {
    let s: Schedules;
    const { work, dispatched, observeOf, money } = t2dHarness(() => s);

    beforeAll(async () => {
      s = await openSchedules('solt2drace', 1_000_000);
    }, 180_000);

    afterAll(async () => {
      await s?.db.drop();
    });

    it('a concurrent failure cannot leave a late effect on the settled attempt', async () => {
      const w = await work();
      await dispatched(w);
      await s.db.admin.execute(
        `create function public.sol_t2d_pause_comment() returns trigger language plpgsql as $$
       begin
         perform pg_advisory_xact_lock(hashtextextended('sol-t2d-comment', 0));
         return new;
       end $$`,
      );
      await s.db.admin.execute(
        `create trigger sol_t2d_pause_comment before insert on public.records for each row
         when (new.data ->> 'body' = 'Sol concurrent effect')
         execute function public.sol_t2d_pause_comment()`,
      );

      let release!: () => void;
      let locked!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const blocker = racer(s);
      const commenter = racer(s);
      const holding = blocker.withBusiness(s.business, async (tx) => {
        await tx.query("select pg_advisory_xact_lock(hashtextextended('sol-t2d-comment', 0))");
        locked();
        await gate;
      });
      await ready;

      const effect = asAgent(
        s,
        {
          command: 'task.comment',
          operationId: effectOperationId(w.attemptId),
          recordId: w.taskId,
          body: 'Sol concurrent effect',
          audience: 'internal',
        },
        w.credential,
        commenter,
      );
      let failure: unknown;
      let observed: ReturnType<typeof observeOf> | undefined;
      let observerFinished = false;
      try {
        await awaitParked(s, 'advisory', 1);
        observed = observeOf(w, { usage: PRICED, outcome: 'failed' }).finally(() => {
          observerFinished = true;
        });
        let staged = false;
        for (let attempt = 0; attempt < 400; attempt += 1) {
          if (observerFinished) {
            staged = true;
            break;
          }
          // Polling must read each database state before waiting for the next.
          // eslint-disable-next-line no-await-in-loop
          const waiters = await s.db.admin.execute<{ readonly n: string }>(
            `select count(*)::text as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`,
          );
          if (Number(waiters[0]?.n ?? 0) >= 2) {
            staged = true;
            break;
          }
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => {
            setTimeout(resolve, 25);
          });
        }
        if (!staged)
          throw new Error('the observation neither finished nor queued behind the effect');
      } catch (cause) {
        failure = cause;
      } finally {
        release();
        await holding;
      }
      const answered = await effect;
      await commenter.close();
      await blocker.close();
      await s.db.admin.execute('drop trigger sol_t2d_pause_comment on public.records');
      await s.db.admin.execute('drop function public.sol_t2d_pause_comment()');
      if (failure !== undefined) throw failure;
      if (observed === undefined) throw new Error('observation never started');
      await observed;
      const outcome = (await money(w))?.['outcome'];
      expect(`${codeOf(answered)}:${String(outcome)}`).not.toBe('applied:failed');
    }, 60_000);

    it("a wrong-client effect identity never waits on that client's step", async () => {
      const own = await work();
      const foreign = await work();
      await dispatched(foreign);
      await s.db.app.withBusiness(s.business, async (tx) => {
        await grantTo(tx, s.decider, 'share');
      });
      const world = cq8World(s);
      await world.client(s.business, s.decider, 'sol-own-client', own.taskId);
      await world.client(s.business, s.decider, 'sol-foreign-client', foreign.taskId);

      const steps = await s.db.admin.execute<{ readonly step_id: string }>(
        'select step_id from public.attempts where business_id = $1 and id = $2',
        [s.business, foreign.attemptId],
      );
      const stepId = steps[0]?.step_id;
      if (stepId === undefined) throw new Error('foreign attempt has no step');
      const blocker = await holdRows(s, 'planned_steps', [stepId]);
      const caller = racer(s);
      let finished = false;
      const pending = asAgent(
        s,
        {
          command: 'task.comment',
          operationId: effectOperationId(foreign.attemptId),
          recordId: own.taskId,
          body: 'This belongs to another client.',
          audience: 'internal',
        },
        own.credential,
        caller,
      ).finally(() => {
        finished = true;
      });
      let crossed = false;
      try {
        for (let attempt = 0; attempt < 400; attempt += 1) {
          if (finished) break;
          // eslint-disable-next-line no-await-in-loop
          const waits = await s.db.admin.execute<{ readonly n: string }>(
            `select count(*)::text as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
              and query like '%public.planned_steps%'`,
          );
          if (Number(waits[0]?.n ?? 0) > 0) {
            crossed = true;
            break;
          }
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => {
            setTimeout(resolve, 25);
          });
        }
      } finally {
        await blocker.release();
      }
      const answer = await pending;
      await caller.close();
      expect(codeOf(answer)).toBe('EFFECT_NOT_DISPATCHED');
      expect(crossed).toBe(false);
    }, 60_000);
  },
);
