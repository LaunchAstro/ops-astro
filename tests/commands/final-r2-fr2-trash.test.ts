// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 2, the trash lane: restore and purge.
//
// R1-THERMO-16 (carried) and R2-RUNTIME-15: restoreBatch read the parent for
// its PARENT_TRASHED check without a lock, so a trash of that parent in
// between left a restored child live under a trashed parent, outside its batch.
//
// R2-RUNTIME-16: the purge deleted a task and left its comments live, pointing
// at nothing, and reachable by no operation.
//
// R2-RUNTIME-53: the purge deleted by id without asking again whether the row
// was still in the trash, so a restore committing in between faulted it.
//
// R2-AUTHORITY-60: the purge deleted a shared task and left the grants scoped
// to it live.
//
// R2-RUNTIME-55: restore and purge stored counts and threw away the ids they
// touched.
//
// R2-SURFACE-66: a whole-number window longer than the database's calendar
// faulted the purge instead of purging nothing.
//
// Interleavings are observed through pg_stat_activity rather than slept
// through, and a case whose interleaving cannot happen at a head says so by
// its final state rather than by a timeout.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { readAuditEvents } from '../../packages/core-records/src/commands/audit.ts';
import { restoreBatch, trashSubtree } from '../../packages/core-records/src/tasks/trash.ts';
import { isRecordsRefusal } from '../../packages/core-records/src/records/refusals.ts';
import {
  installBusinessSettings,
  writeBusinessSetting,
} from '../../packages/core-records/src/records/business-settings.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'final-r2-fr2-trash: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Request = Parameters<typeof executeCommand>[4];
type Answer = Awaited<ReturnType<typeof executeCommand>>;

/** An answer, or the fault it ended in, so a fault is asserted rather than thrown. */
const settled = async (answer: Promise<Answer>): Promise<Answer | { readonly fault: unknown }> =>
  await answer.catch((fault: unknown) => ({ fault }));

describe.skipIf(serverUrl === undefined)('final review round 2: trash, restore and purge', () => {
  let db: FreshDatabase;
  let business: string;
  let worker: Member;
  let second: Database;

  /** Whether a backend in this database is parked on a lock, by the deadline. */
  const blockedOnLock = async (deadline: number): Promise<boolean> => {
    const rows = await db.admin.execute<{ readonly pid: number }>(
      `select pid from pg_stat_activity
        where datname = current_database() and state = 'active' and wait_event_type = 'Lock'
        limit 1`,
    );
    if (rows.length > 0) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    return await blockedOnLock(deadline);
  };

  const runOn = async (database: Database, command: Readonly<Record<string, unknown>>) =>
    await executeCommand(
      database,
      business,
      worker.presented,
      'api',
      command as unknown as Request,
    );

  const run = async (command: Readonly<Record<string, unknown>>) => await runOn(db.app, command);

  const create = async (extra: Readonly<Record<string, unknown>> = {}) => {
    const made = await run({
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'trash lane' },
      ...extra,
    });
    if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
    return made.recordId ?? '';
  };

  const read = async (recordId: string) => {
    const rows = await db.admin.execute<{
      readonly revision: string;
      readonly deleted_at: Date | null;
      readonly trash_batch_id: string | null;
    }>(
      `select revision::text as revision, deleted_at, trash_batch_id::text as trash_batch_id
         from records where business_id = $1 and id = $2`,
      [business, recordId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return { ...row, revision: Number(row.revision) };
  };

  const mustRead = async (recordId: string) => {
    const row = await read(recordId);
    if (row === undefined) throw new Error('read: gone');
    return row;
  };

  const trash = async (recordId: string) => {
    const answer = await run({
      command: 'task.trash',
      operationId: randomUUID(),
      recordId,
      expectedRevision: (await mustRead(recordId)).revision,
    });
    if (isCommandRefusal(answer)) throw new Error(`trash refused ${answer.code}`);
    return String(answer.detail['batchId']);
  };

  const restore = async (batchId: string) =>
    await run({ command: 'task.restore', operationId: randomUUID(), batchId });

  const purge = async () => await run({ command: 'task.purge', operationId: randomUUID() });

  /** The window, written straight into the row, as an administrator would. */
  const setWindow = async (value: string) => {
    await db.admin.execute(
      `update business_settings set value = ${value}
        where business_id = $1 and key = 'retention_window_days'`,
      [business],
    );
  };

  const failedEvents = async () =>
    (await db.app.withBusiness(business, readAuditEvents)).filter(
      (event) => event.outcome === 'failed',
    ).length;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'fr2trash' });
    second = connect(db.appUrl, { source: 'runtime' });
    business = await insertBusiness(db.app, 'final-r2-fr2-trash');
    await installSpine(db.app, business);
    await db.app.withBusiness(business, installBusinessSettings);
    worker = await enrol(db.app, business, 'trasher');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, worker, 'write');
      await grantTo(tx, worker, 'manage');
      await grantTo(tx, worker, 'comment');
      const written = await writeBusinessSetting(tx, { key: 'retention_window_days', value: 0 });
      if (written === undefined || 'refused' in written) throw new Error('window not written');
    });
  }, 60_000);

  afterAll(async () => {
    await second?.close();
    await db?.drop();
  });

  describe('R1-THERMO-16 and R2-RUNTIME-15: restore locks the parent it checks', () => {
    it('makes a trash of the parent wait, and then takes the restored child into its batch', async () => {
      const parent = await create();
      const child = await create({ parentId: parent });
      const childBatch = await trash(child);
      const revision = (await mustRead(parent)).revision;
      let trashing: Promise<Answer> | undefined;
      let waited = false;

      await db.app.withBusiness(business, async (tx) => {
        const restored = await restoreBatch(tx, { batchId: childBatch });
        if (isRecordsRefusal(restored)) throw new Error(`restore refused ${restored.code}`);
        trashing = runOn(second, {
          command: 'task.trash',
          operationId: randomUUID(),
          recordId: parent,
          expectedRevision: revision,
        });
        waited = await blockedOnLock(Date.now() + 2_000);
      });

      const trashed = await trashing;
      if (trashed === undefined || isCommandRefusal(trashed)) throw new Error('trash refused');
      const after = await mustRead(child);
      expect(after.deleted_at).not.toBeNull();
      expect(after.trash_batch_id).toBe((await mustRead(parent)).trash_batch_id);
      expect(waited).toBe(true);
    }, 20_000);

    it('makes the restore wait on a trash of the parent, and then refuses it PARENT_TRASHED', async () => {
      const parent = await create();
      const child = await create({ parentId: parent });
      const childBatch = await trash(child);
      let restoring: Promise<Answer> | undefined;
      let waited = false;
      let parentBatch = '';

      await second.withBusiness(business, async (tx) => {
        // What the envelope does for task.trash: the target, locked, then the walk.
        await tx.query(`select id from records where business_id = $1 and id = $2 for update`, [
          business,
          parent,
        ]);
        const trashed = await trashSubtree(tx, { rootId: parent, actorId: worker.actorId });
        if (isRecordsRefusal(trashed)) throw new Error(`trash refused ${trashed.code}`);
        parentBatch = trashed.batchId;
        restoring = restore(childBatch);
        waited = await blockedOnLock(Date.now() + 2_000);
      });

      const restored = await restoring;
      if (restored === undefined) throw new Error('no restore ran');
      expect((await mustRead(child)).deleted_at).not.toBeNull();
      expect(
        isCommandRefusal(restored) ? [restored.code, restored.names] : 'applied',
      ).toStrictEqual(['PARENT_TRASHED', [child, parentBatch]]);
      expect(waited).toBe(true);
    }, 20_000);
  });

  describe('R2-RUNTIME-16: the purge removes the comments of the tasks it purges', () => {
    it('purges a task and both of its comments, and keeps a live task’s comments', async () => {
      const doomed = await create();
      const kept = await create();
      for (const [task, audience] of [
        [doomed, 'internal'],
        [doomed, 'client'],
        [kept, 'internal'],
      ] as const) {
        /* eslint-disable no-await-in-loop -- one comment after another */
        const said = await run({
          command: 'task.comment',
          operationId: randomUUID(),
          recordId: task,
          expectedRevision: (await mustRead(task)).revision,
          body: `a ${audience} word`,
          audience,
        });
        if (isCommandRefusal(said)) throw new Error(`comment refused ${said.code}`);
        /* eslint-enable no-await-in-loop */
      }
      await trash(doomed);

      const purged = await purge();
      if (isCommandRefusal(purged)) throw new Error(`purge refused ${purged.code}`);

      const comments = async (task: string) =>
        (
          await db.admin.execute<{ readonly count: string }>(
            `select count(*)::text as count from records r
               join record_types t on t.business_id = r.business_id and t.id = r.record_type_id
              where r.business_id = $1 and t.key = 'task_comment' and r.uuid_1 = $2`,
            [business, task],
          )
        )[0]?.count;
      expect(await read(doomed)).toBeUndefined();
      expect(await comments(doomed)).toBe('0');
      expect(await comments(kept)).toBe('1');
      expect(purged.detail['commentsPurged']).toBe(2);
    }, 20_000);
  });

  describe('R2-AUTHORITY-60: the purge revokes the grants scoped to what it purged', () => {
    it('leaves no live grant naming a purged task, and keeps a live task’s grant', async () => {
      const doomed = await create();
      const kept = await create();
      const outsider = await enrol(db.app, business, 'outsider');
      await db.app.withBusiness(business, async (tx) => {
        await grantTo(tx, outsider, 'read', { kind: 'record', id: doomed });
        await grantTo(tx, outsider, 'read', { kind: 'record', id: kept });
      });
      await trash(doomed);

      const purged = await purge();
      if (isCommandRefusal(purged)) throw new Error(`purge refused ${purged.code}`);

      const live = async (task: string) =>
        (
          await db.admin.execute<{ readonly count: string }>(
            `select count(*)::text as count from grants
              where business_id = $1 and scope_kind = 'record' and scope_id = $2
                and revoked_at is null`,
            [business, task],
          )
        )[0]?.count;
      expect(await read(doomed)).toBeUndefined();
      expect(await live(doomed)).toBe('0');
      expect(await live(kept)).toBe('1');
      expect(purged.detail['grantsRevoked']).toBe(1);
    }, 20_000);
  });

  describe('R2-RUNTIME-53: the purge asks again, under a lock, whether a row is still trashed', () => {
    it('answers, and leaves the task live, when a restore commits in between', async () => {
      const task = await create();
      const batchId = await trash(task);
      const failedBefore = await failedEvents();
      let purging: Promise<Answer | { readonly fault: unknown }> | undefined;
      let waited = false;

      await second.withBusiness(business, async (tx) => {
        const restored = await restoreBatch(tx, { batchId });
        if (isRecordsRefusal(restored)) throw new Error(`restore refused ${restored.code}`);
        purging = settled(purge());
        waited = await blockedOnLock(Date.now() + 2_000);
      });

      const purged = await purging;
      expect(waited).toBe(true);
      if (purged === undefined) throw new Error('no purge ran');
      expect('fault' in purged ? 'fault' : isCommandRefusal(purged) ? purged.code : 'applied').toBe(
        'applied',
      );
      expect((await mustRead(task)).deleted_at).toBeNull();
      expect(await failedEvents()).toBe(failedBefore);
    }, 20_000);
  });

  describe('R2-RUNTIME-55: restore and purge store the ids they touched', () => {
    /** The stored result the register keeps for one operation, as text. */
    const stored = async (operationId: string) =>
      (
        await db.admin.execute<{ readonly result: string }>(
          `select result::text as result from operations
            where business_id = $1 and operation_id = $2`,
          [business, operationId],
        )
      )[0]?.result ?? '';

    it('names the root and its descendant in what each operation stores', async () => {
      const root = await create();
      const child = await create({ parentId: root });
      const batchId = await trash(root);

      const restoreId = randomUUID();
      const restored = await run({ command: 'task.restore', operationId: restoreId, batchId });
      if (isCommandRefusal(restored)) throw new Error(`restore refused ${restored.code}`);
      const restoreStored = await stored(restoreId);
      expect([root, child].filter((id) => restoreStored.includes(id))).toStrictEqual([root, child]);
      expect(restored.detail['restored']).toBe(2);

      await trash(root);
      const purgeId = randomUUID();
      const purged = await run({ command: 'task.purge', operationId: purgeId });
      if (isCommandRefusal(purged)) throw new Error(`purge refused ${purged.code}`);
      const purgeStored = await stored(purgeId);
      expect([root, child].filter((id) => purgeStored.includes(id))).toStrictEqual([root, child]);
      expect(purged.detail['purged']).toBe((purged.detail['purgedIds'] as string[]).length);
    }, 20_000);
  });

  describe('R2-SURFACE-66: a window past the calendar purges nothing and does not fault', () => {
    it('answers purged 0 for 3,000,000 and 2,147,483,648 days', async () => {
      try {
        for (const value of [`to_jsonb(3000000::numeric)`, `to_jsonb(2147483648::numeric)`]) {
          /* eslint-disable no-await-in-loop -- one window at a time */
          const task = await create();
          await trash(task);
          await db.admin.execute(
            `update records set deleted_at = now() - interval '400 days'
              where business_id = $1 and id = $2`,
            [business, task],
          );
          await setWindow(value);
          const failedBefore = await failedEvents();
          const purged = await settled(purge());
          expect(
            'fault' in purged ? 'fault' : isCommandRefusal(purged) ? purged.code : 'applied',
          ).toBe('applied');
          if (!('fault' in purged) && !isCommandRefusal(purged)) {
            expect(purged.detail['purged']).toBe(0);
          }
          expect(await read(task)).toBeDefined();
          expect(await failedEvents()).toBe(failedBefore);
          /* eslint-enable no-await-in-loop */
        }
      } finally {
        await setWindow(`to_jsonb(0::numeric)`);
      }
    }, 30_000);
  });
});
