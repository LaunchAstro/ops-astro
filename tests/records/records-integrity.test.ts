// SPDX-License-Identifier: AGPL-3.0-only
//
// The rest of what the records migration promises, against a database migrated
// from empty: uniqueness written in the record's own transaction, links that
// cannot cross a business, configuration that cannot be rewritten after the
// fact, and the domain-model conformance set this part can carry.
//
// The conformance half is deliberately negative as well as positive. A set
// that has only ever seen a conforming schema has not been shown to notice
// anything, so each rule is broken on purpose inside a rolled-back transaction
// and the set is required to name the rule it caught.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import { insertField, insertRecord, insertRecordType, updateData } from './fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { domainModelConformance } from '../../packages/core-records/src/records/conformance.ts';
import { readSlotTable } from '../../packages/core-records/src/records/slots.ts';
import {
  describeFindings,
  type Finding,
} from '../../packages/core-records/src/tenancy/conformance.ts';
import {
  connect,
  type AdminConnection,
  type Database,
} from '../../packages/core-records/src/tenancy/database.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'records integrity: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

class Rollback extends Error {}

async function whenSchemaIs(
  admin: AdminConnection,
  breakage: string,
  check: (findings: readonly Finding[]) => void,
): Promise<void> {
  try {
    await admin.transaction(async (execute) => {
      await execute(breakage);
      check(await domainModelConformance(execute));
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

function rules(findings: readonly Finding[]): readonly string[] {
  return findings.map((finding) => finding.rule);
}

describe.skipIf(serverUrl === undefined)('records integrity', () => {
  let db: FreshDatabase;
  let businessId: string;
  let otherBusinessId: string;
  let typeId: string;
  let emailFieldId: string;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'd' });
    businessId = await insertBusiness(db.app, 'integrity');
    otherBusinessId = await insertBusiness(db.app, 'integrity-other');
    await db.app.withBusiness(businessId, async (tx) => {
      typeId = await insertRecordType(tx, 'contact');
      emailFieldId = await insertField(tx, typeId, {
        key: 'email',
        valueType: 'text',
        slot: 'txt_1',
        uniqueValue: true,
      });
      await insertField(tx, typeId, {
        key: 'state',
        valueType: 'uuid',
        slot: 'uuid_1',
        writeMode: 'operation',
        owningOperation: 'task.complete',
      });
    });
  }, 90_000);

  afterAll(async () => {
    await db?.drop();
  });

  describe('uniqueness is a table written in the record transaction', () => {
    it('claims the value when the record is written, with no caller involved', async () => {
      await db.app.withBusiness(businessId, async (tx) => {
        await insertRecord(tx, typeId, { email: 'Ada@Example.com ' });
        const rows = await tx.query<{ readonly canonical_value: string }>(
          `select canonical_value from record_unique_values where field_def_id = $1`,
          [emailFieldId],
        );
        expect(rows.map((row) => row.canonical_value)).toStrictEqual(['ada@example.com']);
      });
    });

    it('refuses a second record claiming the same value, differing only by case and space', async () => {
      await expect(
        db.app.withBusiness(businessId, async (tx) => {
          await insertRecord(tx, typeId, { email: '  ADA@EXAMPLE.COM' });
        }),
      ).rejects.toThrow(/record_unique_values_claim_idx/u);
    });

    it('releases the claim when the record is trashed, and takes it back on restore', async () => {
      // Each expected failure gets its own transaction. A statement that fails
      // aborts the transaction it is in, so a test that keeps writing after one
      // is testing the abort rather than the rule.
      const id = await db.app.withBusiness(businessId, async (tx) => {
        const actorId = await claimingActor(tx.query.bind(tx), tx.businessId);
        const recordId = await insertRecord(tx, typeId, { email: 'grace@example.com' });
        await tx.query(
          `update records set deleted_at = now(), deleted_by_actor_id = $3, trash_batch_id = $4
            where business_id = $1 and id = $2`,
          [businessId, recordId, actorId, crypto.randomUUID()],
        );
        expect(await claims(tx.query.bind(tx), 'grace@example.com')).toBe(0);
        // Someone else may take it while the record is in the trash, which is
        // what "released" means.
        await insertRecord(tx, typeId, { email: 'grace@example.com' });
        return recordId;
      });

      // Restoring then fails loudly rather than restoring a duplicate that
      // nothing would ever have noticed.
      await expect(
        db.app.withBusiness(businessId, async (tx) => {
          await tx.query(
            `update records set deleted_at = null, deleted_by_actor_id = null,
                                trash_batch_id = null
              where business_id = $1 and id = $2`,
            [businessId, id],
          );
        }),
      ).rejects.toThrow(/record_unique_values_claim_idx/u);
    });

    it('lets exactly one of two concurrent writes of the same value through', async () => {
      // The sequential case above is answered by the unique index on its own.
      // This is the case the contract actually names: two writers at once. One
      // blocks on the other's uncommitted claim, and is refused when it commits.
      const first = connect(db.appUrl, { source: 'runtime', log: db.log });
      const second = connect(db.appUrl, { source: 'runtime', log: db.log });
      try {
        const write = async (handle: Database): Promise<void> => {
          await handle.withBusiness(businessId, async (tx) => {
            await insertRecord(tx, typeId, { email: 'concurrent@example.com' });
          });
        };
        const outcomes = await Promise.allSettled([write(first), write(second)]);
        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
        const refused = outcomes.find((outcome) => outcome.status === 'rejected');
        expect(String(refused?.status === 'rejected' ? refused.reason : '')).toMatch(
          /record_unique_values_claim_idx/u,
        );
      } finally {
        await first.close();
        await second.close();
      }
    });

    it('replaces the claim rather than adding one when the value changes', async () => {
      await db.app.withBusiness(businessId, async (tx) => {
        const id = await insertRecord(tx, typeId, { email: 'alan@example.com' });
        await updateData(tx, id, { email: 'alan.turing@example.com' });
        expect(await claims(tx.query.bind(tx), 'alan@example.com')).toBe(0);
        expect(await claims(tx.query.bind(tx), 'alan.turing@example.com')).toBe(1);
      });
    });
  });

  describe('links stay inside one business', () => {
    it('refuses a link to a record in another business', async () => {
      const strangerId = await db.app.withBusiness(otherBusinessId, async (tx) => {
        const otherTypeId = await insertRecordType(tx, 'contact');
        return await insertRecord(tx, otherTypeId, {});
      });
      await expect(
        db.app.withBusiness(businessId, async (tx) => {
          const mine = await insertRecord(tx, typeId, {});
          await tx.query(
            `insert into record_links (business_id, id, link_type, from_record_id, to_record_id)
             values ($1, $2, 'subtask_of', $3, $4)`,
            [businessId, crypto.randomUUID(), mine, strangerId],
          );
        }),
      ).rejects.toThrow(/record_links_to_fkey/u);
    });

    it('refuses the same edge twice and refuses a record linked to itself', async () => {
      const link = async (from: string, to: string): Promise<void> => {
        await db.app.withBusiness(businessId, async (tx) => {
          await tx.query(
            `insert into record_links (business_id, id, link_type, from_record_id, to_record_id)
             values ($1, $2, 'subtask_of', $3, $4)`,
            [businessId, crypto.randomUUID(), from, to],
          );
        });
      };
      const [one, two, alone] = await db.app.withBusiness(businessId, async (tx) => [
        await insertRecord(tx, typeId, {}),
        await insertRecord(tx, typeId, {}),
        await insertRecord(tx, typeId, {}),
      ]);
      await link(one ?? '', two ?? '');
      await expect(link(one ?? '', two ?? '')).rejects.toThrow(/record_links_edge_idx/u);
      await expect(link(alone ?? '', alone ?? '')).rejects.toThrow(/record_links_not_to_itself/u);
    });
  });

  describe('configuration cannot be rewritten after the fact', () => {
    it('refuses a change to a record type key', async () => {
      await expect(
        db.app.withBusiness(businessId, async (tx) => {
          await tx.query(`update record_types set key = 'renamed' where id = $1`, [typeId]);
        }),
      ).rejects.toThrow(/IMMUTABLE_FIELD: record_types.key/u);
    });

    it('refuses a change to a field value type, so a slot never changes type under it', async () => {
      await expect(
        db.app.withBusiness(businessId, async (tx) => {
          await tx.query(`update field_defs set value_type = 'numeric' where id = $1`, [
            emailFieldId,
          ]);
        }),
      ).rejects.toThrow(/IMMUTABLE_FIELD: field_defs.value_type/u);
    });

    it('refuses a second field in a slot the record type has already used', async () => {
      await expect(
        db.app.withBusiness(businessId, async (tx) => {
          await insertField(tx, typeId, { key: 'other', valueType: 'text', slot: 'txt_1' });
        }),
      ).rejects.toThrow(/field_defs_slot_idx/u);
    });

    it('refuses a field with no classification, rather than defaulting it to generic', async () => {
      await expect(
        db.app.withBusiness(businessId, async (tx) => {
          await tx.query(
            `insert into field_defs
               (business_id, id, record_type_id, key, label, value_type, write_mode)
             values ($1, $2, $3, 'loose', 'loose', 'text', 'whatever')`,
            [businessId, crypto.randomUUID(), typeId],
          );
        }),
      ).rejects.toThrow(/field_defs_write_mode_known/u);
    });
  });

  describe('the slot table the engine is written against', () => {
    it('is the shipped shape: 38 slots, the 18 reserved ones indexed and the rest not', async () => {
      const slots = await readSlotTable(db.admin.execute);
      expect(slots).toHaveLength(38);
      const counted = (type: string): number =>
        slots.filter((slot) => slot.valueType === type).length;
      expect([
        counted('uuid'),
        counted('text'),
        counted('timestamptz'),
        counted('numeric'),
        counted('boolean'),
      ]).toStrictEqual([10, 12, 5, 6, 5]);

      // This is the anchor for the model the unit tests run against. Reserved
      // and indexed are the same slots, so a migration that indexed a free
      // slot, or stopped indexing a reserved one, fails here rather than
      // leaving `records-engine` asserting a table nobody ships.
      //
      // Sixteen when T1d shipped, eighteen since T1e: the task spine's
      // classification produced two protected fields that fixed slots 2.2 had
      // no reservation for, `client_visible` and the party link, and migration
      // 0006 reserves and indexes their slots together (specification, 2.3
      // case T1-N3). The pair moving together is what this assertion is for.
      const reserved = slots.filter((slot) => slot.reservation !== null).map((slot) => slot.slot);
      const indexed = slots.filter((slot) => slot.indexed).map((slot) => slot.slot);
      expect(reserved.toSorted()).toStrictEqual(indexed.toSorted());
      expect(reserved).toHaveLength(18);
    });
  });

  describe('the domain-model conformance set', () => {
    it('is green on the migrated schema with the seeded configuration', async () => {
      const findings = await domainModelConformance(db.admin.execute);
      expect(describeFindings(findings)).toBe('');
      expect(findings).toStrictEqual([]);
    });

    it('catches a slotted field assigned to a slot with no index', async () => {
      await whenSchemaIs(
        db.admin,
        `insert into public.field_defs
           (business_id, id, record_type_id, key, label, value_type, slot, write_mode)
         select '${businessId}', gen_random_uuid(), '${typeId}', 'unindexed', 'unindexed',
                'boolean', 'bool_2', 'generic'`,
        (findings) => {
          expect(rules(findings)).toContain(
            'an assigned slot carries an index, so a slotted field is a fast field',
          );
        },
      );
    });

    it('catches a slot column the registry does not name', async () => {
      await whenSchemaIs(
        db.admin,
        'alter table public.records add column txt_13 text',
        (findings) => {
          expect(rules(findings)).toContain('every slot column on records is registered');
        },
      );
    });

    it('catches a registered slot the table does not have', async () => {
      await whenSchemaIs(db.admin, 'alter table public.records drop column bool_5', (findings) => {
        expect(rules(findings)).toContain('every registered slot is a column on records');
      });
    });

    it('catches a preset field sitting in a reserved spine slot', async () => {
      await whenSchemaIs(
        db.admin,
        `insert into public.field_defs
           (business_id, id, record_type_id, key, label, value_type, slot, write_mode, origin)
         select '${businessId}', gen_random_uuid(), '${typeId}', 'squatter', 'squatter',
                'timestamptz', 'ts_1', 'generic', 'preset'`,
        (findings) => {
          expect(rules(findings)).toContain('a reserved slot holds a core field only');
        },
      );
    });

    it('catches a reserved slot whose index has gone', async () => {
      await whenSchemaIs(db.admin, 'drop index public.records_uuid_1_idx', (findings) => {
        expect(rules(findings)).toContain('every reserved slot carries an index');
      });
    });

    it('catches the classification constraints being dropped', async () => {
      await whenSchemaIs(
        db.admin,
        `alter table public.field_defs drop constraint field_defs_operation_named,
                                       drop constraint field_defs_write_mode_known`,
        (findings) => {
          expect(rules(findings)).toContain(
            'the field definition refuses an unclassified field in the schema',
          );
        },
      );
    });

    it('catches a generic field that names an owning operation', async () => {
      await whenSchemaIs(
        db.admin,
        `alter table public.field_defs drop constraint field_defs_operation_named;
         update public.field_defs set owning_operation = 'task.assign' where key = 'email'`,
        (findings) => {
          expect(rules(findings)).toContain('only an operation-owned field names an operation');
        },
      );
    });
  });
});

type Query = <Row>(text: string, parameters?: readonly unknown[]) => Promise<readonly Row[]>;

async function claims(query: Query, value: string): Promise<number> {
  const rows = await query<{ readonly count: string }>(
    `select count(*)::text as count from record_unique_values where canonical_value = $1`,
    [value],
  );
  return Number(rows[0]?.count ?? '-1');
}

/** An actor to name in the trash envelope, because trashing records who did it. */
async function claimingActor(query: Query, businessId: string): Promise<string> {
  const personId = crypto.randomUUID();
  const actorId = crypto.randomUUID();
  await query(`insert into people (business_id, id, display_name) values ($1, $2, 'trasher')`, [
    businessId,
    personId,
  ]);
  await query(
    `insert into actors (business_id, id, kind, person_id) values ($1, $2, 'person', $3)`,
    [businessId, actorId, personId],
  );
  return actorId;
}
