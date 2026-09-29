// SPDX-License-Identifier: AGPL-3.0-only
//
// The two checks migration 0009 put on `field_defs.owning_operation` when it
// became `text[]`, each refusing a bad row by name (product issue 54). The
// array form was written green by other suites, but nothing showed either
// check biting, so a migration that dropped one would have passed them all.
//
// - `field_defs_owning_operation_not_empty`: an empty list is the same absence
//   as null wearing a different shape.
// - `field_defs_operation_names_are_operations`: every element is spelled as
//   a `family.verb` operation name, and none is null. It reads the spelling
//   only (0009's pattern): a well-formed name no command owns, such as
//   `task.no_such_operation`, passes it, and so does `preset.plan`. Nothing in
//   the product refuses such a name yet; that is a follow-up, not this suite.
//
// A valid list is written alongside as the control, so each refusal is about
// the value and not about the row around it. An empty list fails both checks,
// and Postgres names the first in name order, so `not_empty` is shown on its
// own with the other check dropped inside a transaction that rolls back.
// S0-6's question 6 (the `text[]` domain change) reads this suite's result as
// its evidence.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import { insertField, insertRecordType } from './fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('CQ-14 owning operation constraints', () => {
  let db: FreshDatabase;
  let businessId: string;
  let typeId: string;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'd' });
    businessId = await insertBusiness(db.app, 'owning-operation');
    await db.app.withBusiness(businessId, async (tx) => {
      typeId = await insertRecordType(tx, 'owned');
    });
  }, 90_000);

  afterAll(async () => {
    await db?.drop();
  });

  const operationField = async (key: string, owningOperations: readonly string[]) =>
    await db.app.withBusiness(businessId, async (tx) => {
      await insertField(tx, typeId, {
        key,
        valueType: 'text',
        writeMode: 'operation',
        owningOperations,
      });
    });

  it('accepts a list of operation names, the control', async () => {
    await expect(
      operationField('owned_by_two', ['task.complete', 'task.reopen']),
    ).resolves.toBeUndefined();
  });

  it('refuses an empty list by field_defs_owning_operation_not_empty', async () => {
    await expect(operationField('owned_by_none', [])).rejects.toThrow(
      /field_defs_operation_names_are_operations/u,
    );
    class Rollback extends Error {}
    const alone = db.admin.transaction(async (execute) => {
      await execute(
        `alter table public.field_defs drop constraint field_defs_operation_names_are_operations`,
      );
      await execute(
        `insert into public.field_defs
           (business_id, id, record_type_id, key, label, value_type, write_mode, owning_operation)
         values ($1, $2, $3, 'owned_by_none', 'owned_by_none', 'text', 'operation', '{}')`,
        [businessId, randomUUID(), typeId],
      );
      throw new Rollback();
    });
    await expect(alone).rejects.toThrow(/field_defs_owning_operation_not_empty/u);
    const kept = await db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from pg_constraint
        where conname = 'field_defs_operation_names_are_operations'`,
    );
    expect(kept[0]?.n, 'the dropped check came back with the rollback').toBe('1');
  });

  it('refuses a malformed operation name by field_defs_operation_names_are_operations', async () => {
    await expect(operationField('owned_by_nothing', ['complete'])).rejects.toThrow(
      /field_defs_operation_names_are_operations/u,
    );
    await expect(
      operationField('owned_by_one_and_nothing', ['task.complete', 'Task Complete']),
    ).rejects.toThrow(/field_defs_operation_names_are_operations/u);
  });

  it('wrote only the control', async () => {
    const rows = await db.admin.execute<{ readonly key: string }>(
      `select key from public.field_defs where business_id = $1 and record_type_id = $2`,
      [businessId, typeId],
    );
    expect(rows.map((row) => row.key)).toStrictEqual(['owned_by_two']);
  });
});
