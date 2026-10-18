// SPDX-License-Identifier: AGPL-3.0-only
//
// `activations_change_one_step` (20261018033724) asks that a change stamps
// `changed_at` with `now()`, the time its transaction began, not the time it
// took the row. A transaction opened before another change committed then
// writes the next revision stamped before the one it follows, and a
// transaction held open back-dates its change by as long as it was held: the
// back-dating the trigger was added to refuse. Each writer has a connection
// of its own.

import { afterAll, beforeAll, expect, it } from 'vitest';
import { openSchedules, racer, type Schedules } from '../runtime/schedules-harness.ts';
import { seedAutomation, type SeededAutomation } from './seed.ts';

const noDatabase = process.env['DATABASE_URL'] === undefined;

let s: Schedules;
let seeded: SeededAutomation;
beforeAll(async () => {
  if (noDatabase) return;
  s = await openSchedules('activationclock', 1_000_000);
  seeded = await seedAutomation(s.db.admin, s.business, s.decider.actorId);
}, 180_000);
afterAll(async () => {
  await s?.db.drop();
});

const CHANGE = `update public.activations
    set enabled = not enabled, revision = revision + 1, changed_by_actor_id = $2, changed_at = now()
  where id = $1
  returning revision::int, changed_at::text`;

interface Changed {
  readonly revision: number;
  readonly changed_at: string;
}

/** A promise and the call that settles it. */
function gate(): { readonly passed: Promise<void>; readonly open: () => void } {
  let resolve: (() => void) | undefined;
  const passed = new Promise<void>((done) => {
    resolve = done;
  });
  return { passed, open: () => resolve?.() };
}

/** What the second change came to against the first: refused, in order, or stamped before it. */
async function judged(first: Changed | undefined, second: Changed | string | undefined) {
  if (typeof second === 'string' || second === undefined) {
    return second === '23514' ? 'refused' : `failed ${String(second)}`;
  }
  const [order] = await s.db.admin.execute<{ before: boolean }>(
    'select $1::timestamptz < $2::timestamptz as before',
    [second.changed_at, first?.changed_at],
  );
  return order?.before === true
    ? `revision ${String(second.revision)} stamped before revision ${String(first?.revision)}`
    : 'in order';
}

it.skipIf(noDatabase)(
  'a change whose transaction began before the last one committed is not stamped before it',
  async () => {
    const late = racer(s);
    const begun = gate();
    const go = gate();
    try {
      const lateChange = late
        .withBusiness(s.business, async (tx) => {
          await tx.query('select 1');
          begun.open();
          await go.passed;
          return await tx.query<Changed>(CHANGE, [seeded.activationId, s.decider.actorId]);
        })
        .then(
          (rows) => rows[0],
          (error: unknown) => String((error as { code?: unknown }).code),
        );
      await begun.passed;
      const [first] = await s.db.app.withBusiness(
        s.business,
        async (tx) => await tx.query<Changed>(CHANGE, [seeded.activationId, s.decider.actorId]),
      );
      go.open();
      expect(['refused', 'in order']).toContain(await judged(first, await lateChange));
    } finally {
      go.open();
      await late.close();
    }
  },
);
