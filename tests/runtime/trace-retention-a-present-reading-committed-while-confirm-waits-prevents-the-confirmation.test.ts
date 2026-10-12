// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention: confirmation and every writer of a read's result take the
// business's export cursor row lock first, and confirmation judges the run's
// history only once it holds the lock. A run read gone in one pass is read
// gone again in the next; meanwhile another pass holds the lock and records
// the run read present. Once that commits, the waiting confirmation sees the
// present result as the latest and confirms nothing.

import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it } from 'vitest';
import type { ExpiryPorts } from '../../packages/core-runtime/src/index.ts';
import { gate } from './aw-13-race-world.ts';
import { noDatabase, t, useAw13World } from './aw-13-world.ts';
import { confirmed, dueRuns, pass, traceOf } from './trace-retention-pass-world.ts';

useAw13World('trret_present_while_confirm_waits');

it.skipIf(noDatabase)(
  'Trace retention: a present reading committed while confirm waits prevents the confirmation',
  async () => {
    const s = t.alpha;
    const [runId = ''] = await dueRuns(s, 'trace retention present while confirm waits', 1);
    await pass(s, t.target.expiry);
    expect(await confirmed(s, runId), 'one absence confirms nothing').toBe(false);

    // Another pass takes the lock as the second pass reads the run gone.
    const locked = gate();
    let other: Promise<void> | undefined;
    const ports: ExpiryPorts = {
      expire: t.target.expiry.expire,
      present: async (trace, span) => {
        const answer = await t.target.expiry.present(trace, span);
        if (trace === traceOf(s, runId)) {
          other = s.db.app.withBusiness(s.business, async (tx) => {
            const [turn] = await tx.query<{ seq: string }>(
              `update public.trace_export_cursors set pass_seq = pass_seq + 1
                where business_id = $1 returning pass_seq::text as seq`,
              [s.business],
            );
            await locked.arrive();
            await tx.query(
              `insert into public.trace_expiry_batches
                 (business_id, id, window_days, runs, expired_run_ids, code, pass_id, pass_seq,
                  present_run_ids)
               values ($1, gen_random_uuid(), 30, 1, '{}', 'expiry_unconfirmed',
                       gen_random_uuid(), $2::bigint, array[$3::uuid])`,
              [s.business, turn?.seq, runId],
            );
          });
          await locked.reached;
        }
        return answer;
      },
    };
    const second = pass(s, ports);
    await locked.reached;
    await sleep(500);
    locked.release();
    await other;
    await second;
    expect(await confirmed(s, runId), 'the later present result stops the confirmation').toBe(
      false,
    );
  },
);
