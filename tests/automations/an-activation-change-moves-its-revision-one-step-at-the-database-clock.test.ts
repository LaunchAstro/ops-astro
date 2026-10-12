// SPDX-License-Identifier: AGPL-3.0-only
//
// An activation's revision serialises two changes, and its standing approval
// names the revision it wrote. The application role wrote both the revision
// and `changed_at` itself, so a direct statement could roll the revision back
// to one an approval already names, skip ahead, or back-date the change. The
// database now holds each change to one step, stamped with its own clock.

import { afterAll, beforeAll, expect, it } from 'vitest';
import { openSchedules, type Schedules } from '../runtime/schedules-harness.ts';
import { seedAutomation, type SeededAutomation } from './seed.ts';

const noDatabase = process.env['DATABASE_URL'] === undefined;

let s: Schedules;
let seeded: SeededAutomation;
beforeAll(async () => {
  if (noDatabase) return;
  s = await openSchedules('activationstep', 1_000_000);
  seeded = await seedAutomation(s.db.admin, s.business, s.decider.actorId);
}, 180_000);
afterAll(async () => {
  await s?.db.drop();
});

const change = async (set: string) =>
  await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await tx.query<{ revision: string; stamped: boolean }>(
        `update public.activations set ${set}, changed_by_actor_id = $2
          where id = $1
          returning revision::text, changed_at = now() as stamped`,
        [seeded.activationId, s.decider.actorId],
      ),
  );

it.skipIf(noDatabase)('a change one revision on, at now, applies', async () => {
  await expect(
    change('enabled = true, revision = revision + 1, changed_at = now()'),
  ).resolves.toEqual([{ revision: '2', stamped: true }]);
});

it.skipIf(noDatabase)(
  'a change that rolls the revision back, skips ahead, keeps it, or back-dates is refused',
  async () => {
    const written = await Promise.allSettled([
      change('enabled = false, revision = 1, changed_at = now()'),
      change('enabled = false, revision = revision + 5, changed_at = now()'),
      change('enabled = false, changed_at = now()'),
      change(`enabled = false, revision = revision + 1, changed_at = now() - interval '1 day'`),
    ]);
    expect(written).toMatchObject(
      written.map(() => ({ status: 'rejected', reason: { code: '23514' } })),
    );
    const [stored] = await s.db.admin.execute<{ revision: string; enabled: boolean }>(
      'select revision::text, enabled from public.activations where id = $1',
      [seeded.activationId],
    );
    expect(stored).toEqual({ revision: '2', enabled: true });
  },
);
