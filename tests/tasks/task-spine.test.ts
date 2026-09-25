// SPDX-License-Identifier: AGPL-3.0-only
//
// `task_spine`: the invariant test T1e is split against.
//
// The specification states it in four halves (section 6, T1e): every
// slot-assigned spine field has a non-null `write_mode`; a record with a
// parent cannot carry a board section; a new task ranks after its siblings;
// and a restore returns exactly its own batch. It passes only with T1d landed,
// and only against a database migrated from empty.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertActor, insertBusiness, insertPerson } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { installTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import { TASK_SPINE } from '../../packages/core-records/src/tasks/spine.ts';
import { planTaskPlacement } from '../../packages/core-records/src/tasks/placement.ts';
import { isRecordsRefusal } from '../../packages/core-records/src/records/refusals.ts';
import { restoreBatch, trashSubtree } from '../../packages/core-records/src/tasks/trash.ts';
import { createTask, readSlots } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('task_spine: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

describe.skipIf(serverUrl === undefined)('task_spine', () => {
  let db: FreshDatabase;
  let businessId: string;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'e' });
    businessId = await insertBusiness(db.app, 'task-spine');
    await db.app.withBusiness(businessId, async (tx) => {
      await installTaskSpine(tx);
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  describe('every slot-assigned spine field has a write mode', () => {
    it('installs each spine field into the slot the reservation names', async () => {
      const rows = await db.app.withBusiness(businessId, async (tx) =>
        tx.query<{ key: string; slot: string | null; write_mode: string }>(
          `select f.key, f.slot, f.write_mode
             from field_defs f join record_types t
               on t.business_id = f.business_id and t.id = f.record_type_id
            where f.business_id = $1 and t.key = 'task' and f.slot is not null
            order by f.key`,
          [businessId],
        ),
      );
      // Slot and classification together. `write_mode` is `not null` with a
      // check constraint, so asserting only that it is non-empty would be
      // asserting the schema; what this has to catch is a spine field landing
      // in the wrong slot or carrying a classification the contract does not
      // give it.
      const installed = rows
        .map((row) => `${row.key}=${row.slot ?? ''}:${row.write_mode}`)
        .toSorted();
      const declared = TASK_SPINE.filter((field) => field.slot !== null)
        .map((field) => `${field.key}=${field.slot ?? ''}:${field.writeMode}`)
        .toSorted();
      expect(installed).toStrictEqual(declared);
    });
  });

  describe('a record with a parent cannot carry a board section', () => {
    // Written through `data`, because that is the only way a slot is ever
    // written: the trigger rebuilds every slot from `data` before the row
    // lands, so a test that set the columns directly would prove that the
    // trigger cleared them, not that the constraint bit.
    it('refuses the pair through the projection, in the database', async () => {
      await expect(
        db.app.withBusiness(businessId, async (tx) => {
          const spine = await installTaskSpine(tx);
          await tx.query(
            `insert into records (business_id, id, record_type_id, data)
             values ($1, gen_random_uuid(), $2, $3)`,
            [
              businessId,
              spine.taskTypeId,
              { parent: randomUUID(), board_section: randomUUID(), title: 'a subtask on a board' },
            ],
          );
        }),
      ).rejects.toThrow(/records_subtask_has_no_board_section/u);
    });

    it('derives a subtask’s placement instead of reading it from the request', async () => {
      const { parentSlots, childSlots } = await db.app.withBusiness(businessId, async (tx) => {
        const spine = await installTaskSpine(tx);
        // A board is a live task here (R2-RUNTIME-19): a fabricated id is refused.
        const board = await createTask(tx, spine, { title: 'a board', parentId: null });
        const parent = await createTask(tx, spine, {
          title: 'the parent',
          parentId: null,
          board,
          boardSection: randomUUID(),
        });
        const child = await createTask(tx, spine, { title: 'the subtask', parentId: parent });
        return {
          parentSlots: await readSlots(tx, parent),
          childSlots: await readSlots(tx, child),
        };
      });
      // Inherited, not supplied; and the section is empty even though the
      // parent has one.
      expect(childSlots['uuid_5']).toBe(parentSlots['uuid_5']);
      expect(childSlots['uuid_6']).toBeNull();
      expect(parentSlots['uuid_6']).not.toBeNull();
    });

    it('refuses a subtask that names a board section, and a create that names a rank', async () => {
      const refusals = await db.app.withBusiness(businessId, async (tx) => {
        const spine = await installTaskSpine(tx);
        const parent = await createTask(tx, spine, { title: 'a parent', parentId: null });
        return [
          await planTaskPlacement(tx, spine.taskTypeId, {
            parentId: parent,
            boardSection: randomUUID(),
          }),
          await planTaskPlacement(tx, spine.taskTypeId, {
            parentId: null,
            suppliedKeys: ['title', 'board_rank'],
          }),
        ];
      });
      for (const refusal of refusals) {
        expect(isRecordsRefusal(refusal) && refusal.code).toBe('PLACEMENT_IS_DERIVED');
      }
      expect(isRecordsRefusal(refusals[0]!) && refusals[0].names).toStrictEqual(['board_section']);
      expect(isRecordsRefusal(refusals[1]!) && refusals[1].names).toStrictEqual(['board_rank']);
    });
  });

  describe('a new task ranks after its siblings', () => {
    it('puts each new sibling last, under a parent and on a board', async () => {
      const ranks = await db.app.withBusiness(businessId, async (tx) => {
        const spine = await installTaskSpine(tx);
        const board = await createTask(tx, spine, { title: 'a board', parentId: null });
        const first = await createTask(tx, spine, { title: 'first', parentId: null, board });
        const second = await createTask(tx, spine, { title: 'second', parentId: null, board });
        const childA = await createTask(tx, spine, { title: 'child a', parentId: first });
        const childB = await createTask(tx, spine, { title: 'child b', parentId: first });
        const other = await createTask(tx, spine, {
          title: 'another board',
          parentId: null,
          board: await createTask(tx, spine, { title: 'the other board', parentId: null }),
        });
        const rank = async (id: string): Promise<number> =>
          Number((await readSlots(tx, id))['num_2']);
        return {
          first: await rank(first),
          second: await rank(second),
          childA: await rank(childA),
          childB: await rank(childB),
          other: await rank(other),
        };
      });
      expect(ranks.second).toBeGreaterThan(ranks.first);
      expect(ranks.childB).toBeGreaterThan(ranks.childA);
      // A different board is a different sibling set, so its first task starts
      // over rather than continuing someone else's numbering.
      expect(ranks.other).toBe(ranks.first);
      // The children rank among themselves, not after their parent's board.
      expect(ranks.childA).toBe(ranks.first);
    });
  });

  describe('a restore returns exactly its own batch', () => {
    // Three levels, which is where the trash batch and the placement rule both
    // bite (specification, 10.1). The grandchild is trashed on its own first,
    // so it carries an earlier batch when the subtree above it is trashed.
    it('leaves a child trashed in an earlier batch behind', async () => {
      const seen = await db.app.withBusiness(businessId, async (tx) => {
        const spine = await installTaskSpine(tx);
        const actorId = await insertActor(tx, await insertPerson(tx, 'the deleter'));
        const root = await createTask(tx, spine, { title: 'root', parentId: null });
        const child = await createTask(tx, spine, { title: 'child', parentId: root });
        const grandchild = await createTask(tx, spine, { title: 'grandchild', parentId: child });

        const earlier = await trashSubtree(tx, { rootId: grandchild, actorId });
        if (isRecordsRefusal(earlier)) throw new Error(earlier.code);
        const later = await trashSubtree(tx, { rootId: root, actorId });
        if (isRecordsRefusal(later)) throw new Error(later.code);

        const restored = await restoreBatch(tx, { batchId: later.batchId });
        if (isRecordsRefusal(restored)) throw new Error(restored.code);

        const state = async (id: string): Promise<string | null> =>
          (await readSlots(tx, id))['trash_batch_id'] as string | null;
        return {
          laterBatch: later.batchId,
          earlierBatch: earlier.batchId,
          laterHeld: later.recordIds.toSorted(),
          restoredIds: restored.recordIds.toSorted(),
          root: await state(root),
          child: await state(child),
          grandchild: await state(grandchild),
        };
      });

      // The second act took the root and the child, and left the grandchild in
      // the batch it was already in.
      expect(seen.laterHeld).toHaveLength(2);
      expect(seen.restoredIds).toStrictEqual(seen.laterHeld);
      expect(seen.root).toBeNull();
      expect(seen.child).toBeNull();
      expect(seen.grandchild).toBe(seen.earlierBatch);
      expect(seen.earlierBatch).not.toBe(seen.laterBatch);
    });

    it('refuses a child whose parent is still trashed, naming the batch to restore first', async () => {
      const refusal = await db.app.withBusiness(businessId, async (tx) => {
        const spine = await installTaskSpine(tx);
        const actorId = await insertActor(tx, await insertPerson(tx, 'the deleter'));
        const root = await createTask(tx, spine, { title: 'a root', parentId: null });
        const child = await createTask(tx, spine, { title: 'a child', parentId: root });

        // The child alone first, then everything above it. Restoring the
        // child's own batch would leave it under a parent still in the trash.
        const childBatch = await trashSubtree(tx, { rootId: child, actorId });
        if (isRecordsRefusal(childBatch)) throw new Error(childBatch.code);
        const rootBatch = await trashSubtree(tx, { rootId: root, actorId });
        if (isRecordsRefusal(rootBatch)) throw new Error(rootBatch.code);
        return {
          refused: await restoreBatch(tx, { batchId: childBatch.batchId }),
          rootBatch: rootBatch.batchId,
        };
      });
      expect(isRecordsRefusal(refusal.refused) && refusal.refused.code).toBe('PARENT_TRASHED');
      expect(isRecordsRefusal(refusal.refused) && refusal.refused.names).toContain(
        refusal.rootBatch,
      );
    });
  });
});
