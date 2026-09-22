// SPDX-License-Identifier: AGPL-3.0-only
//
// `slot_law`: the invariant test T1d is split against.
//
// The specification states it in two halves (section 6, T1d): a write of a
// slotted field's value lands in the slot in the same statement, and a view
// naming a non-slotted field is refused `FIELD_NOT_SLOTTED`. It passes only
// with the trigger and the view validator both landed, and only against a
// database migrated from empty.
//
// Around those two are the cases that make the first half mean something. A
// projection that only ever runs forwards would satisfy "the value lands in
// the slot" while leaving a stale value behind when the key is removed, or
// letting a direct slot write stand beside a `data` that disagrees. Each of
// those is a second owner of one fact, which is the thing the trigger exists
// to prevent.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import { insertField, insertRecord, insertRecordType, readRecord, updateData } from './fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { validateView } from '../../packages/core-records/src/records/views.ts';
import type { FieldDefinition } from '../../packages/core-records/src/records/fields.ts';
import { isRecordsRefusal } from '../../packages/core-records/src/records/refusals.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('slot_law: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

/** The field definitions as the view validator sees them, mirroring the seeded rows. */
function definition(
  recordTypeId: string,
  key: string,
  overrides: Partial<FieldDefinition> = {},
): FieldDefinition {
  return {
    id: `${recordTypeId}:${key}`,
    recordTypeId,
    key,
    valueType: 'text',
    slot: null,
    writeMode: 'generic',
    owningOperation: null,
    escalatingOperation: null,
    visibilityClass: 'internal',
    searchable: false,
    uniqueValue: false,
    origin: 'core',
    deactivatedAt: null,
    ...overrides,
  };
}

describe.skipIf(serverUrl === undefined)('slot_law', () => {
  let db: FreshDatabase;
  let businessId: string;
  let typeId: string;
  let titleFieldId: string;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'd' });
    businessId = await insertBusiness(db.app, 'slot-law');
    await db.app.withBusiness(businessId, async (tx) => {
      typeId = await insertRecordType(tx, 'task');
      titleFieldId = await insertField(tx, typeId, {
        key: 'title',
        valueType: 'text',
        slot: 'txt_4',
        searchable: true,
      });
      await insertField(tx, typeId, { key: 'state', valueType: 'uuid', slot: 'uuid_1' });
      await insertField(tx, typeId, { key: 'due', valueType: 'timestamptz', slot: 'ts_1' });
      await insertField(tx, typeId, { key: 'priority', valueType: 'numeric', slot: 'num_1' });
      // No slot: the field a view is not allowed to filter on.
      await insertField(tx, typeId, { key: 'description', valueType: 'text' });
    });
  }, 90_000);

  afterAll(async () => {
    await db?.drop();
  });

  describe('a write lands in the slot in the same statement', () => {
    it('projects every slotted value on insert, and returns it from the insert itself', async () => {
      const stateId = crypto.randomUUID();
      await db.app.withBusiness(businessId, async (tx) => {
        const rows = await tx.query<Record<string, unknown>>(
          `insert into records (business_id, id, record_type_id, data)
           values ($1, $2, $3, $4)
           returning txt_4, uuid_1, ts_1, num_1, revision`,
          [
            businessId,
            crypto.randomUUID(),
            typeId,
            {
              title: 'Draft the slot law',
              state: stateId,
              due: '2026-09-30T00:00:00Z',
              priority: 3,
              description: 'lives in data only',
            },
          ],
        );
        const row = rows[0] ?? {};
        expect(row['txt_4']).toBe('Draft the slot law');
        expect(row['uuid_1']).toBe(stateId);
        expect(row['num_1']).toBe('3');
        expect(new Date(row['ts_1'] as string).toISOString()).toBe('2026-09-30T00:00:00.000Z');
        expect(row['revision']).toBe('1');
      });
    });

    it('is immediately filterable on the slot it just wrote', async () => {
      await db.app.withBusiness(businessId, async (tx) => {
        await insertRecord(tx, typeId, { title: 'findable at once' });
        const rows = await tx.query<{ readonly id: string }>(
          `select id from records where record_type_id = $1 and txt_4 = $2`,
          [typeId, 'findable at once'],
        );
        expect(rows).toHaveLength(1);
      });
    });

    it('leaves an unslotted field in data and in no column', async () => {
      await db.app.withBusiness(businessId, async (tx) => {
        const id = await insertRecord(tx, typeId, { description: 'no slot for this' });
        const row = await readRecord(tx, id);
        expect((row['data'] as Record<string, unknown>)['description']).toBe('no slot for this');
        for (const column of ['txt_1', 'txt_4', 'txt_5', 'txt_12']) {
          expect(row[column]).toBeNull();
        }
      });
    });
  });

  describe('the slot has one owner', () => {
    it('does not persist a slot column written directly', async () => {
      await db.app.withBusiness(businessId, async (tx) => {
        const id = await insertRecord(tx, typeId, { title: 'the real title' });
        await tx.query(`update records set txt_4 = $3 where business_id = $1 and id = $2`, [
          businessId,
          id,
          'a title nobody wrote in data',
        ]);
        const row = await readRecord(tx, id);
        expect(row['txt_4']).toBe('the real title');
      });
    });

    it('empties the slot when the key leaves data', async () => {
      await db.app.withBusiness(businessId, async (tx) => {
        const id = await insertRecord(tx, typeId, { title: 'here for now', priority: 9 });
        await updateData(tx, id, { priority: 9 });
        const row = await readRecord(tx, id);
        expect(row['txt_4']).toBeNull();
        expect(row['num_1']).toBe('9');
      });
    });

    it('stops projecting a field that has been deactivated', async () => {
      await db.app.withBusiness(businessId, async (tx) => {
        const id = await insertRecord(tx, typeId, { title: 'projected while live' });
        expect((await readRecord(tx, id))['txt_4']).toBe('projected while live');
        await tx.query(`update field_defs set deactivated_at = now() where id = $1`, [
          titleFieldId,
        ]);
        await updateData(tx, id, { title: 'projected while live' });
        expect((await readRecord(tx, id))['txt_4']).toBeNull();
        await tx.query(`update field_defs set deactivated_at = null where id = $1`, [titleFieldId]);
      });
    });

    it('refuses a value the slot cannot hold, rather than storing null and filtering it later', async () => {
      await expect(
        db.app.withBusiness(businessId, async (tx) => {
          await insertRecord(tx, typeId, { state: 'not a uuid at all' });
        }),
      ).rejects.toThrow(/invalid input syntax for type uuid/u);
    });

    it('counts the revision up on the server and ignores what a writer asks for', async () => {
      await db.app.withBusiness(businessId, async (tx) => {
        const id = await insertRecord(tx, typeId, { title: 'first' });
        await tx.query(
          `update records set data = $3, revision = 99 where business_id = $1 and id = $2`,
          [businessId, id, { title: 'second' }],
        );
        expect((await readRecord(tx, id))['revision']).toBe('2');
      });
    });
  });

  describe('search reads searchable slots and nothing else', () => {
    it('finds a term in a searchable slotted field', async () => {
      await db.app.withBusiness(businessId, async (tx) => {
        await insertRecord(tx, typeId, { title: 'quarterly reconciliation' });
        const rows = await tx.query<{ readonly id: string }>(
          `select id from records
            where record_type_id = $1 and search_tsv @@ plainto_tsquery('english', $2)`,
          [typeId, 'reconciliation'],
        );
        expect(rows).toHaveLength(1);
      });
    });

    it('does not find a term that lives only in unsearchable data', async () => {
      await db.app.withBusiness(businessId, async (tx) => {
        await insertRecord(tx, typeId, { description: 'chinchilla' });
        const rows = await tx.query(
          `select id from records
            where record_type_id = $1 and search_tsv @@ plainto_tsquery('english', $2)`,
          [typeId, 'chinchilla'],
        );
        expect(rows).toHaveLength(0);
      });
    });
  });

  describe('a view names only slotted fields', () => {
    it('refuses a filter on a field with no slot, naming the field', () => {
      const result = validateView(
        {
          recordTypeId: typeId,
          filters: [{ field: 'description' }],
          sort: [],
          visibleFields: ['title'],
        },
        [definition(typeId, 'title', { slot: 'txt_4' }), definition(typeId, 'description')],
      );
      expect(isRecordsRefusal(result)).toBe(true);
      if (!isRecordsRefusal(result)) return;
      expect(result.code).toBe('FIELD_NOT_SLOTTED');
      expect(result.names).toStrictEqual(['description']);
    });

    it('accepts a filter and a sort on slotted fields', () => {
      const result = validateView(
        {
          recordTypeId: typeId,
          filters: [{ field: 'state' }],
          sort: [{ field: 'priority' }],
          visibleFields: ['title', 'description'],
        },
        [
          definition(typeId, 'state', { valueType: 'uuid', slot: 'uuid_1' }),
          definition(typeId, 'priority', { valueType: 'numeric', slot: 'num_1' }),
        ],
      );
      expect(isRecordsRefusal(result)).toBe(false);
    });

    it('refuses at read time a sort on a field that was deactivated after the view was saved', () => {
      const result = validateView(
        { recordTypeId: typeId, filters: [], sort: [{ field: 'title' }], visibleFields: [] },
        [definition(typeId, 'title', { slot: 'txt_4', deactivatedAt: new Date() })],
      );
      expect(isRecordsRefusal(result) && result.code).toBe('FIELD_UNKNOWN');
    });
  });
});
