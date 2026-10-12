// SPDX-License-Identifier: AGPL-3.0-only
//
// A slot is indexed when an index on `records` can search it: the slot column
// is one of that index's key columns. A column carried in an INCLUDE list is
// stored in the index but is never searched by it, so a slot whose only index
// occurrence is an INCLUDE column is unindexed. The slot catalogue, slot
// planning and the domain-model conformance set must all say so.
//
// Each case replaces `bool_5`'s own index with one that only INCLUDEs it,
// inside a rolled-back transaction.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import { insertRecordType } from './fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { domainModelConformance } from '../../packages/core-records/src/records/conformance.ts';
import { planSlotAssignment } from '../../packages/core-records/src/records/fields.ts';
import { readSlotTable, type Slot } from '../../packages/core-records/src/records/slots.ts';
import type { Finding } from '../../packages/core-records/src/tenancy/conformance.ts';
import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'include-only slot index: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const INCLUDE_ONLY = `drop index public.records_bool_5_idx;
  create index records_business_include_bool_5
    on public.records (business_id) include (bool_5)`;

class Rollback extends Error {}

async function inRolledBackSchema<T>(
  admin: AdminConnection,
  breakage: string,
  look: (execute: AdminConnection['execute']) => Promise<T>,
): Promise<T> {
  let seen: T | undefined;
  try {
    await admin.transaction(async (execute) => {
      await execute(breakage);
      seen = await look(execute);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  if (seen === undefined)
    throw new Error('the look inside the rolled-back transaction did not run');
  return seen;
}

function bool5(slots: readonly Slot[]): Slot {
  const slot = slots.find((each) => each.slot === 'bool_5');
  if (slot === undefined) throw new Error('bool_5 is missing from the slot table');
  return slot;
}

const ASSIGNED_TO_BOOL_5 = `insert into public.field_defs
    (business_id, id, record_type_id, key, label, value_type, slot, write_mode)
  select business_id, gen_random_uuid(), id, 'included', 'included', 'boolean', 'bool_5',
         'generic'
    from public.record_types where key = 'contact'`;

/** A migrated database with one business and a `contact` record type. */
async function contactDatabase(): Promise<FreshDatabase> {
  const db = await createFreshDatabase({ part: 'd' });
  const businessId = await insertBusiness(db.app, 'include-only');
  await db.app.withBusiness(businessId, async (tx) => {
    await insertRecordType(tx, 'contact');
  });
  return db;
}

describe.skipIf(serverUrl === undefined)('a slot named only in an index INCLUDE list', () => {
  let db: FreshDatabase;

  beforeAll(async () => {
    db = await contactDatabase();
  }, 90_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('is read from the catalogue as unindexed', async () => {
    const slots = await inRolledBackSchema(db.admin, INCLUDE_ONLY, readSlotTable);
    expect(bool5(slots).indexed).toBe(false);
  });

  it('is refused by slot planning, named or not', async () => {
    const slots = await inRolledBackSchema(db.admin, INCLUDE_ONLY, readSlotTable);
    const onlyBool5 = slots.filter(
      (slot) => !slot.slot.startsWith('bool_') || slot.slot === 'bool_5',
    );
    const preset = { valueType: 'boolean', origin: 'preset' } as const;
    expect(planSlotAssignment({ ...preset, requestedSlot: 'bool_5' }, slots, [])).toMatchObject({
      code: 'SLOT_INDEX_ABSENT',
    });
    expect(planSlotAssignment(preset, onlyBool5, [])).toMatchObject({ code: 'SLOT_INDEX_ABSENT' });
  });

  it('fails index conformance when a field is assigned to it', async () => {
    const findings: readonly Finding[] = await inRolledBackSchema(
      db.admin,
      `${INCLUDE_ONLY}; ${ASSIGNED_TO_BOOL_5}`,
      domainModelConformance,
    );
    expect(findings).toContainEqual({
      rule: 'an assigned slot carries an index, so a slotted field is a fast field',
      object: 'contact.included',
      detail: 'bool_5 has no index',
    });
  });

  it('is still indexed when it is a key column after another', async () => {
    const keyAfterAnother = `drop index public.records_bool_5_idx;
      create index records_business_bool_5 on public.records (business_id, bool_5) include (txt_1)`;
    const slots = await inRolledBackSchema(db.admin, keyAfterAnother, readSlotTable);
    expect(bool5(slots).indexed).toBe(true);
  });
});
