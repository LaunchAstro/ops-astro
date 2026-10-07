// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import { connect, raiseInboxItem, type Database } from '../../packages/core-records/src/index.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { createTask, openSchedules } from '../runtime/schedules-harness.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

function latch() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release?.() };
}

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'an inbox read under way when task read is revoked does not name the task by a title given after',
  // eslint-disable-next-line max-lines-per-function -- one controlled interleaving and its cleanup
  async () => {
    const s = await openSchedules('inboxtaskrace', 1_000_000);
    const reader = connect(s.db.appUrl);
    const reached = latch();
    const resume = latch();
    const paused: Database = {
      log: reader.log,
      close: () => reader.close(),
      withBusiness: (business, run) =>
        reader.withBusiness(business, (tx) =>
          run({
            ...tx,
            async query<Row>(
              statement: string,
              parameters?: readonly unknown[],
            ): Promise<readonly Row[]> {
              if (statement.includes('as task_title')) {
                reached.release();
                await resume.promise;
              }
              return await tx.query<Row>(statement, parameters);
            },
          }),
        ),
    };
    let reading: ReturnType<typeof executeRead> | undefined;
    try {
      const taskId = await createTask(s, 'Title before task read was revoked');
      const mia = await enrol(s.db.app, s.business, 'mia');
      const grantId = await s.db.app.withBusiness(s.business, async (tx) => {
        const id = await grantTo(tx, mia, 'read', { kind: 'record', id: taskId });
        await raiseInboxItem(tx, {
          recipientPersonId: mia.personId,
          subjectRecordId: taskId,
          reason: 'mention',
          fact: { kind: 'record', id: randomUUID() },
        });
        return id;
      });
      const before = await executeRead(s.db.app, s.business, mia.presented, { read: 'inbox.read' });
      expect(JSON.stringify(before)).toContain('Title before task read was revoked');
      reading = executeRead(paused, s.business, mia.presented, { read: 'inbox.read' });
      await reached.promise;
      await s.db.admin.execute('update public.grants set revoked_at = now() where id = $1', [
        grantId,
      ]);
      const newTitle = 'Task title written after task read was revoked';
      await s.db.admin.execute(
        `update public.records set data = data || jsonb_build_object('title', $2::text)
          where id = $1`,
        [taskId, newTitle],
      );
      resume.release();
      expect(JSON.stringify(await reading)).not.toContain(newTitle);
    } finally {
      resume.release();
      await reading;
      await reader.close();
      await s.db.drop();
    }
  },
  180_000,
);
