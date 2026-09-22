// SPDX-License-Identifier: AGPL-3.0-only
//
// The trash batch, and the retention classes it is not.
//
// `task_spine` proves the one half the split names: a restore returns exactly
// its own batch. These are the cases around it that make the batch mean
// something — that a trashed row leaves the working set, that it releases and
// retakes its unique values, and that the purge operation refuses everything
// outside the work class.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertActor, insertBusiness, insertPerson } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { installTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import {
  purgeTrashedRecords,
  refusePurgeOfTable,
  restoreBatch,
  trashSubtree,
} from '../../packages/core-records/src/tasks/trash.ts';
import { isRecordsRefusal } from '../../packages/core-records/src/records/refusals.ts';
import { createTask, readSlots } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('task trash: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

describe.skipIf(serverUrl === undefined)('task trash and retention', () => {
  let db: FreshDatabase;
  let businessId: string;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'e' });
    businessId = await insertBusiness(db.app, 'task-trash');
    await db.app.withBusiness(businessId, async (tx) => {
      await installTaskSpine(tx);
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('stamps one batch across a root and every descendant not already trashed', async () => {
    const seen = await db.app.withBusiness(businessId, async (tx) => {
      const spine = await installTaskSpine(tx);
      const actorId = await insertActor(tx, await insertPerson(tx, 'a deleter'));
      const root = await createTask(tx, spine, { title: 'root', parentId: null });
      const a = await createTask(tx, spine, { title: 'a', parentId: root });
      const b = await createTask(tx, spine, { title: 'b', parentId: root });
      const deep = await createTask(tx, spine, { title: 'deep', parentId: a });
      const result = await trashSubtree(tx, { rootId: root, actorId });
      if (isRecordsRefusal(result)) throw new Error(result.code);
      const row = await readSlots(tx, deep);
      return { count: result.recordIds.length, batch: result.batchId, deep: row, b };
    });
    expect(seen.count).toBe(4);
    expect(seen.deep['trash_batch_id']).toBe(seen.batch);
    // The three parts of the envelope move together, which the schema also says.
    expect(seen.deep['deleted_at']).not.toBeNull();
    expect(seen.deep['deleted_by_actor_id']).not.toBeNull();
  });

  it('refuses a second trash of a row already in the trash, naming its batch', async () => {
    const seen = await db.app.withBusiness(businessId, async (tx) => {
      const spine = await installTaskSpine(tx);
      const actorId = await insertActor(tx, await insertPerson(tx, 'a deleter'));
      const task = await createTask(tx, spine, { title: 'trash me twice', parentId: null });
      const first = await trashSubtree(tx, { rootId: task, actorId });
      if (isRecordsRefusal(first)) throw new Error(first.code);
      return { first: first.batchId, again: await trashSubtree(tx, { rootId: task, actorId }) };
    });
    expect(isRecordsRefusal(seen.again) && seen.again.code).toBe('ALREADY_TRASHED');
    expect(isRecordsRefusal(seen.again) && seen.again.names).toContain(seen.first);
  });

  it('is not in the working set while it is in the trash', async () => {
    const counts = await db.app.withBusiness(businessId, async (tx) => {
      const spine = await installTaskSpine(tx);
      const actorId = await insertActor(tx, await insertPerson(tx, 'a deleter'));
      const board = crypto.randomUUID();
      await createTask(tx, spine, { title: 'stays', parentId: null, board });
      const going = await createTask(tx, spine, { title: 'goes', parentId: null, board });
      const live = async (): Promise<number> => {
        const rows = await tx.query<{ readonly n: string }>(
          `select count(*)::text as n from records
            where business_id = $1 and record_type_id = $2
              and deleted_at is null and uuid_5 = $3`,
          [businessId, spine.taskTypeId, board],
        );
        return Number(rows[0]?.n ?? '0');
      };
      const before = await live();
      const trashed = await trashSubtree(tx, { rootId: going, actorId });
      if (isRecordsRefusal(trashed)) throw new Error(trashed.code);
      const during = await live();
      const restored = await restoreBatch(tx, { batchId: trashed.batchId });
      if (isRecordsRefusal(restored)) throw new Error(restored.code);
      return { before, during, after: await live() };
    });
    expect(counts).toStrictEqual({ before: 2, during: 1, after: 2 });
  });

  it('releases a unique value into the trash and takes it back on restore', async () => {
    const seen = await db.app.withBusiness(businessId, async (tx) => {
      const spine = await installTaskSpine(tx);
      const actorId = await insertActor(tx, await insertPerson(tx, 'a deleter'));
      const task = await createTask(tx, spine, { title: 'holds a key', parentId: null });
      const held = async (): Promise<number> => {
        const rows = await tx.query<{ readonly n: string }>(
          `select count(*)::text as n from record_unique_values
            where business_id = $1 and record_id = $2`,
          [businessId, task],
        );
        return Number(rows[0]?.n ?? '0');
      };
      const before = await held();
      const trashed = await trashSubtree(tx, { rootId: task, actorId });
      if (isRecordsRefusal(trashed)) throw new Error(trashed.code);
      const during = await held();
      const restored = await restoreBatch(tx, { batchId: trashed.batchId });
      if (isRecordsRefusal(restored)) throw new Error(restored.code);
      return { before, during, after: await held() };
    });
    expect(seen).toStrictEqual({ before: 1, during: 0, after: 1 });
  });

  it('refuses a restore whose unique value was taken while it was in the trash', async () => {
    const refusal = await db.app.withBusiness(businessId, async (tx) => {
      const spine = await installTaskSpine(tx);
      const actorId = await insertActor(tx, await insertPerson(tx, 'a deleter'));
      const task = await createTask(tx, spine, { title: 'the original', parentId: null });
      const key = (await readSlots(tx, task))['txt_1'] as string;
      const trashed = await trashSubtree(tx, { rootId: task, actorId });
      if (isRecordsRefusal(trashed)) throw new Error(trashed.code);

      // Somebody takes the key while the record is out of the working set.
      await tx.query(
        `insert into records (business_id, id, record_type_id, data)
         values ($1, gen_random_uuid(), $2, $3)`,
        [businessId, spine.taskTypeId, { title: 'the usurper', key }],
      );
      return { key, refused: await restoreBatch(tx, { batchId: trashed.batchId }) };
    });
    expect(isRecordsRefusal(refusal.refused) && refusal.refused.code).toBe('UNIQUE_VALUE_TAKEN');
    expect(isRecordsRefusal(refusal.refused) && refusal.refused.names).toStrictEqual([
      'key',
      refusal.key.toLowerCase(),
    ]);
  });

  // Case L10's rule: an absent link alone does not prove abandonment. A parent
  // that is gone leaves a child pointing at nothing, and refusing that restore
  // would leave a row nobody could ever recover. The parent is deleted outright
  // here rather than purged, because the claim under test is the restore's and
  // a purge wide enough to take the parent would take the child with it.
  it('restores a child whose parent no longer exists at all', async () => {
    const seen = await db.app.withBusiness(businessId, async (tx) => {
      const spine = await installTaskSpine(tx);
      const actorId = await insertActor(tx, await insertPerson(tx, 'a deleter'));
      const parent = await createTask(tx, spine, { title: 'the doomed parent', parentId: null });
      const child = await createTask(tx, spine, { title: 'the survivor', parentId: parent });

      const batch = await trashSubtree(tx, { rootId: child, actorId });
      if (isRecordsRefusal(batch)) throw new Error(batch.code);
      // The parent goes into the trash first and is then removed. It has to:
      // `record_unique_values` holds a foreign key to `records`, so a live
      // record cannot be deleted at all, and the trash is what releases its
      // claims. A purge that skipped the trash would be refused by the server.
      const parentBatch = await trashSubtree(tx, { rootId: parent, actorId });
      if (isRecordsRefusal(parentBatch)) throw new Error(parentBatch.code);
      await tx.query(`delete from records where business_id = $1 and id = $2`, [
        businessId,
        parent,
      ]);

      const restored = await restoreBatch(tx, { batchId: batch.batchId });
      if (isRecordsRefusal(restored)) throw new Error(restored.code);
      return { restored: restored.recordIds, slots: await readSlots(tx, child), child, parent };
    });
    expect(seen.restored).toStrictEqual([seen.child]);
    expect(seen.slots['deleted_at']).toBeNull();
    // The parent slot still names a record that is not there, which is a
    // different state from an unlinked one and the two stay distinguishable.
    expect(seen.slots['uuid_4']).toBe(seen.parent);
  });

  // `parent` is an ordinary uuid slot with no foreign key to itself, so nothing
  // in the schema stops a loop, and a recursive walk over one does not return.
  // This is the case that proves the guard rather than the SQL that claims it.
  it('terminates on a parent cycle instead of walking it forever', async () => {
    const seen = await db.app.withBusiness(businessId, async (tx) => {
      const spine = await installTaskSpine(tx);
      const actorId = await insertActor(tx, await insertPerson(tx, 'a deleter'));
      const a = await createTask(tx, spine, { title: 'a', parentId: null });
      const b = await createTask(tx, spine, { title: 'b', parentId: a });
      // Close the loop by hand: a's parent becomes b. No command would do this
      // and no constraint stops it.
      await tx.query(
        `update records set data = data || jsonb_build_object('parent', $3::text)
          where business_id = $1 and id = $2`,
        [businessId, a, b],
      );
      const trashed = await trashSubtree(tx, { rootId: a, actorId });
      if (isRecordsRefusal(trashed)) throw new Error(trashed.code);
      return { ids: trashed.recordIds.toSorted(), expected: [a, b].toSorted() };
    });
    expect(seen.ids).toStrictEqual(seen.expected);
  }, 15_000);

  it('answers NOT_FOUND for a batch identity nobody carries and a record nobody has', async () => {
    const refusals = await db.app.withBusiness(businessId, async (tx) => [
      await restoreBatch(tx, { batchId: crypto.randomUUID() }),
      await trashSubtree(tx, { rootId: crypto.randomUUID(), actorId: crypto.randomUUID() }),
    ]);
    for (const refusal of refusals) {
      expect(isRecordsRefusal(refusal) && refusal.code).toBe('NOT_FOUND');
    }
  });

  describe('retention', () => {
    it('purges the work class with the window set to nothing', async () => {
      const seen = await db.app.withBusiness(businessId, async (tx) => {
        const spine = await installTaskSpine(tx);
        const actorId = await insertActor(tx, await insertPerson(tx, 'a deleter'));
        const task = await createTask(tx, spine, { title: 'purge me', parentId: null });
        const trashed = await trashSubtree(tx, { rootId: task, actorId });
        if (isRecordsRefusal(trashed)) throw new Error(trashed.code);
        // A window of nothing: everything already in the trash is past it.
        const purged = await purgeTrashedRecords(tx, {
          recordTypeId: spine.taskTypeId,
          trashedBefore: new Date(Date.now() + 1000),
        });
        const rows = await tx.query<{ readonly id: string }>(
          `select id from records where business_id = $1 and id = $2`,
          [businessId, task],
        );
        return { purged, gone: rows.length === 0, task };
      });
      expect(isRecordsRefusal(seen.purged)).toBe(false);
      expect(!isRecordsRefusal(seen.purged) && seen.purged.recordIds).toContain(seen.task);
      expect(seen.gone).toBe(true);
    });

    it('refuses a record type outside the work class in the same run', async () => {
      const refusal = await db.app.withBusiness(businessId, async (tx) => {
        const rows = await tx.query<{ readonly id: string }>(
          `insert into record_types (business_id, id, key, name, origin, retention_class)
           values ($1, gen_random_uuid(), 'audit_trail', 'Audit trail', 'core', 'evidence')
           returning id`,
          [businessId],
        );
        return await purgeTrashedRecords(tx, {
          recordTypeId: rows[0]!.id,
          trashedBefore: new Date(Date.now() + 1000),
        });
      });
      expect(isRecordsRefusal(refusal) && refusal.code).toBe('RETENTION_CLASS_PROTECTED');
      expect(isRecordsRefusal(refusal) && refusal.names).toStrictEqual(['audit_trail', 'evidence']);
    });

    // The refusal is written before the evidence tables exist, because a purge
    // that learns about evidence later has already run once.
    it('refuses to name a table in the evidence class, and one nobody classified', () => {
      for (const table of ['audit_events', 'gate_decisions']) {
        const refusal = refusePurgeOfTable(table);
        expect(refusal?.code).toBe('RETENTION_CLASS_PROTECTED');
        expect(refusal?.names).toStrictEqual([table, 'evidence']);
      }
      expect(refusePurgeOfTable('runs')?.names).toStrictEqual(['runs', 'runtime']);
      expect(refusePurgeOfTable('grants')?.names).toStrictEqual(['grants', 'unclassified']);
      expect(refusePurgeOfTable('records')).toBeUndefined();
    });
  });
});
