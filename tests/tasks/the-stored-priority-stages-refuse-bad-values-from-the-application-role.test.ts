// SPDX-License-Identifier: AGPL-3.0-only
//
// The priority stages setting is checked again where it is stored
// (20261011083203): a direct write by the application role, past the command's
// own check, still cannot store a duplicate, unknown, non-string or
// out-of-order stage id, more than six, or a stage-id value under another key.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { openSchedules, type Schedules } from '../runtime/schedules-harness.ts';

const noDatabase = process.env['DATABASE_URL'] === undefined;

let s: Schedules;
beforeAll(async () => {
  if (noDatabase) return;
  s = await openSchedules('prioritycheck', 1_000_000);
  await s.db.app.withBusiness(s.business, installBusinessSettings);
}, 180_000);
afterAll(async () => {
  await s?.db.drop();
});

const store = async (value: unknown) =>
  await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await tx.query(
        `update public.business_settings set value = $1::text::jsonb
          where business_id = $2 and key = 'priority_stages' returning 1`,
        [JSON.stringify(value), s.business],
      ),
  );

const BAD: readonly unknown[] = [
  null,
  'awareness',
  { awareness: true },
  [1],
  [{}],
  ['trust', 'trust'],
  ['awareness', 'leads'],
  ['ops'],
  ['sales', 'awareness'],
  ['awareness', 'trust', 'enquiries', 'sales', 'retention', 'advocacy', 'advocacy'],
];

it.skipIf(noDatabase)('a stage list in journey order is stored', async () => {
  await expect(store(['awareness', 'sales'])).resolves.toHaveLength(1);
});

it.skipIf(noDatabase)(
  'a duplicate, unknown, non-string, out-of-order or overlong stage list is refused by the stored check',
  async () => {
    const written = await Promise.allSettled(BAD.map(async (value) => await store(value)));
    expect(written).toMatchObject(
      BAD.map(() => ({
        status: 'rejected',
        reason: { constraint_name: 'business_settings_value_matches_type' },
      })),
    );
    const [kept] = await s.db.admin.execute<{ value: unknown }>(
      `select value from public.business_settings where business_id = $1 and key = 'priority_stages'`,
      [s.business],
    );
    expect(kept?.value).toStrictEqual(['awareness', 'sales']);
  },
);

it.skipIf(noDatabase)('a stage-id value under another key is refused', async () => {
  await expect(
    s.db.app.withBusiness(
      s.business,
      async (tx) =>
        await tx.query(
          `insert into public.business_settings
             (business_id, id, key, label, value_type, value, write_mode, owning_operation,
              visibility_class, origin)
           values ($1, $2, 'other_stages', 'Other stages', 'stage_ids', '[]'::jsonb, 'operation',
                   array['settings.set_priority_stages'], 'internal', 'core')`,
          [s.business, randomUUID()],
        ),
    ),
  ).rejects.toMatchObject({ constraint_name: 'business_settings_priority_classification' });
});
