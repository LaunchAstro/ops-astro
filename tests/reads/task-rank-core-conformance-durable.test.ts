// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, expect, it } from 'vitest';
import { rankCoreWorld, type RankCoreWorld } from './task-rank-core-world.ts';
import { domainModelConformance } from '../../packages/core-records/src/records/conformance.ts';
import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';
import type { Finding } from '../../packages/core-records/src/tenancy/conformance.ts';

let world: RankCoreWorld;
beforeAll(async () => {
  world = await rankCoreWorld();
}, 180_000);
afterAll(async () => {
  await world?.db.drop();
});

type Read = AdminConnection['execute'];
const DUPLICATE = `insert into public.field_defs
  (business_id, id, record_type_id, key, label, value_type, slot, write_mode,
   owning_operation, escalating_operation, visibility_class, searchable, unique_value, origin)
  select business_id, gen_random_uuid(), record_type_id, 'zz_rank_core_duplicate',
         'Synthetic duplicate title slot', value_type, slot, write_mode,
         owning_operation, escalating_operation, visibility_class, searchable, unique_value, origin
    from public.field_defs
   where business_id = $1 and record_type_id = $2 and key = 'title'
  returning key, slot`;

async function metadata(read: Read) {
  return Array.from(
    await read(`select to_jsonb(f) as field from public.field_defs f
                order by business_id, record_type_id, key`),
  );
}

async function slotIndex(read: Read) {
  return Array.from(
    await read(`select pg_get_indexdef(to_regclass('public.field_defs_slot_idx')) as definition`),
  );
}

async function taskType() {
  const types = await world.db.admin.execute<{ readonly id: string }>(
    `select id from public.record_types where business_id = $1 and key = 'task'`,
    [world.business],
  );
  if (types.length !== 1 || types[0] === undefined)
    throw new Error('Expected one installed task type');
  return types[0].id;
}

class RestoreFixture extends Error {}

async function findingsInsideRolledBackDuplicate(typeId: string): Promise<readonly Finding[]> {
  let findings: readonly Finding[] | undefined;
  try {
    await world.db.admin.transaction(async (read) => {
      // This own fresh synthetic DB normally forbids a duplicate. PostgreSQL
      // rolls back both this DDL and the fixture row when RestoreFixture is thrown.
      await read('drop index public.field_defs_slot_idx');
      const inserted = await read(DUPLICATE, [world.business, typeId]);
      expect(Array.from(inserted)).toStrictEqual([
        { key: 'zz_rank_core_duplicate', slot: 'txt_4' },
      ]);
      findings = await domainModelConformance(read);
      throw new RestoreFixture();
    });
  } catch (error) {
    if (!(error instanceof RestoreFixture)) throw error;
  }
  if (findings === undefined) throw new Error('The actual checker did not inspect the fixture');
  return findings;
}

it('separate businesses can install the same task type and slots without administrative conformance collisions', async () => {
  const read = world.db.admin.execute.bind(world.db.admin);
  const titles = await read<{
    readonly business_id: string;
    readonly type_id: string;
    readonly slot: string;
  }>(
    `select f.business_id, t.id as type_id, f.slot from public.field_defs f
       join public.record_types t on t.business_id = f.business_id and t.id = f.record_type_id
      where t.key = 'task' and f.key = 'title' order by f.business_id`,
  );
  expect(titles).toHaveLength(2);
  expect(new Set(titles.map((row) => row.business_id)).size).toBe(2);
  expect(new Set(titles.map((row) => row.type_id)).size).toBe(2);
  expect(titles.map((row) => row.slot)).toStrictEqual(['txt_4', 'txt_4']);
  expect(await domainModelConformance(read)).toStrictEqual([]);
});

it('a genuine same-business task slot duplicate is reported and its synthetic DDL and metadata roll back exactly', async () => {
  const read = world.db.admin.execute.bind(world.db.admin);
  const typeId = await taskType();
  const beforeFields = await metadata(read);
  const beforeIndex = await slotIndex(read);
  expect(beforeIndex).toStrictEqual([
    {
      definition:
        'CREATE UNIQUE INDEX field_defs_slot_idx ON public.field_defs USING btree (business_id, record_type_id, slot) WHERE (slot IS NOT NULL)',
    },
  ]);
  await expect(read(DUPLICATE, [world.business, typeId])).rejects.toMatchObject({
    code: '23505',
    constraint_name: 'field_defs_slot_idx',
  });
  const findings = await findingsInsideRolledBackDuplicate(typeId);
  // Assert restoration before checking findings, including on the red run.
  expect(await metadata(read)).toStrictEqual(beforeFields);
  expect(await slotIndex(read)).toStrictEqual(beforeIndex);
  expect(findings).toStrictEqual([
    {
      rule: 'one field per slot per record type',
      object: 'task.zz_rank_core_duplicate',
      detail: 'txt_4 is also held by title',
    },
  ]);
  expect(await domainModelConformance(read)).toStrictEqual([]);
});
