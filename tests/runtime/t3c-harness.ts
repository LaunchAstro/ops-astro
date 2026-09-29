// SPDX-License-Identifier: AGPL-3.0-only
//
// The T3c suites' harness (`t3c-write-off.test.ts`, `t3c-write-off-isolation.test.ts`):
// the write-off body, the one hold it closes read back, and the money
// tables' row counts, which a write-off never adds to. Kept apart so each
// suite stays under the per-file cap.

import { randomUUID } from 'node:crypto';
import { rows, type Schedules } from './schedules-harness.ts';
import type { Work } from './t2d-harness.ts';

export const REASON = 'The provider never answered; its statement shows this charge.';

export const writeOffBody = (
  w: Pick<Work, 'taskId' | 'attemptId'>,
  amountMinor: unknown,
  extra: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => ({
  command: 'budget.write_off',
  operationId: randomUUID(),
  recordId: w.taskId,
  attemptId: w.attemptId,
  amountMinor,
  reason: REASON,
  ...extra,
});

/** The attempt, its reservation and its envelope, as the write-off leaves them. */
export const holdOf = async (
  s: Schedules,
  w: Pick<Work, 'attemptId'>,
): Promise<Record<string, unknown> | undefined> =>
  (
    await rows<Record<string, unknown>>(
      s,
      `select att.state as attempt_state, att.outcome, att.actual_minor::text as attempt_actual,
              res.state as reservation_state, res.actual_minor::text as reservation_actual,
              res.classified_cause, env.held_minor::text as envelope_held,
              env.actual_minor::text as envelope_actual
         from public.attempts att
         join public.reservations res on res.business_id = att.business_id and res.id = att.reservation_id
         join public.task_envelopes env on env.business_id = res.business_id and env.id = res.envelope_id
        where att.business_id = $1 and att.id = $2`,
      [s.business, w.attemptId],
    )
  )[0];

/**
 * Rows in every money and work table of this business. A write-off moves the
 * one hold it names and writes no row of its own there: no new attempt, hold,
 * lease or envelope (T3c, split 2.2: "it writes no ledger row").
 */
export const ledgerRows = async (s: Schedules): Promise<Readonly<Record<string, number>>> => {
  const counted: Record<string, number> = {};
  for (const table of ['attempts', 'reservations', 'leases', 'task_envelopes', 'budget_caps']) {
    // Sequential: one connection's reads, in a fixed order.
    // eslint-disable-next-line no-await-in-loop
    const found = await rows<{ readonly n: string }>(
      s,
      `select count(*)::text as n from public.${table} where business_id = $1`,
      [s.business],
    );
    counted[table] = Number(found[0]?.n);
  }
  return counted;
};

/** The shipped band, in whole currency units, for this business. */
export const setBand = async (s: Schedules, value: string): Promise<void> => {
  await s.db.admin.execute(
    `update public.business_settings set value = $2::text::jsonb
      where business_id = $1 and key = 'four_eyes_threshold'`,
    [s.business, value],
  );
};
