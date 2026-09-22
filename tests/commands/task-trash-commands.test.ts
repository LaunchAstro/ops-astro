// SPDX-License-Identifier: AGPL-3.0-only
//
// The trash family, and who is still allowed to call anything.
//
// T1e built the trash, the restore and the purge and left this part what it
// owed them: "the purge writes no audit event, and 14.3 requires one.
// `audit_events` is T1f's table. All three of trash, restore and purge return
// the identifiers they touched so the command can write the event. T1f owes
// these." So each of the three is a command and each goes through the
// envelope.
//
// The purge case is the one to read. The first time it ran against a task a
// command had created it failed on a foreign key: `operations` and
// `audit_events` both pointed at `records`, and a purge is a real delete. An
// earlier version of the case ran the purge after a restore, so nothing was in
// the trash, it purged zero rows and the defect survived. A review found that.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import {
  readAuditEvents,
  readRecordAudit,
} from '../../packages/core-records/src/commands/audit.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('task commands: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

describe.skipIf(serverUrl === undefined)(
  'the task commands: the trash family and revocation',
  () => {
    let db: FreshDatabase;
    let business: string;
    let worker: Member;
    let grants: Record<string, string>;

    const run = async (command: Parameters<typeof executeCommand>[4], who: Member = worker) =>
      await executeCommand(db.app, business, who.presented, 'api', command);

    const create = async (
      fields: Readonly<Record<string, unknown>>,
      extra: Readonly<Record<string, unknown>> = {},
    ) => {
      const made = await run({
        command: 'task.create',
        operationId: randomUUID(),
        fields,
        ...extra,
      } as Parameters<typeof executeCommand>[4]);
      if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
      return made;
    };

    beforeAll(async () => {
      db = await createFreshDatabase({ part: 'f' });
      business = await insertBusiness(db.app, 'task-commands');
      await installSpine(db.app, business);
      worker = await enrol(db.app, business, 'worker');
      grants = await db.app.withBusiness(business, async (tx) => ({
        write: await grantTo(tx, worker, 'write'),
        assign: await grantTo(tx, worker, 'assign'),
        share: await grantTo(tx, worker, 'share'),
        manage: await grantTo(tx, worker, 'manage'),
      }));
    }, 60_000);

    afterAll(async () => {
      await db?.drop();
    });

    describe('the audit event T1e handed on', () => {
      it('writes one for trash, one for restore and one for the purge', async () => {
        const root = await create({ title: 'to be trashed' });
        const child = await create({ title: 'a child' }, { parentId: root.recordId });
        const trashed = await run({
          command: 'task.trash',
          operationId: randomUUID(),
          recordId: root.recordId ?? '',
          expectedRevision: root.revision ?? 0,
        });
        if (isCommandRefusal(trashed)) throw new Error(`trash refused ${trashed.code}`);
        expect(trashed.detail['trashed']).toBe(2);

        const restored = await run({
          command: 'task.restore',
          operationId: randomUUID(),
          batchId: String(trashed.detail['batchId']),
        });
        if (isCommandRefusal(restored)) throw new Error(`restore refused ${restored.code}`);
        expect(restored.detail['restored']).toBe(2);

        const purged = await run({
          command: 'task.purge',
          operationId: randomUUID(),
          olderThanDays: 0,
        });
        if (isCommandRefusal(purged)) throw new Error(`purge refused ${purged.code}`);

        const events = await db.app.withBusiness(business, readAuditEvents);
        const commands = events.map((event) => event.command);
        expect(commands).toContain('task.trash');
        expect(commands).toContain('task.restore');
        expect(commands).toContain('task.purge');
        expect(child.recordId).toBeDefined();
      });

      it('purges a task a command created, and keeps the evidence about it', async () => {
        // The first time this ran it failed on a foreign key: `operations` and
        // `audit_events` both pointed at `records`, and a purge is a real
        // delete. Both pointers are opaque now, because the record is in the
        // work retention class and the two tables that name it are evidence.
        const doomed = await create({ title: 'to be purged' });
        const trashed = await run({
          command: 'task.trash',
          operationId: randomUUID(),
          recordId: doomed.recordId ?? '',
          expectedRevision: doomed.revision ?? 0,
        });
        if (isCommandRefusal(trashed)) throw new Error(`trash refused ${trashed.code}`);

        const purged = await run({
          command: 'task.purge',
          operationId: randomUUID(),
          olderThanDays: 0,
        });
        if (isCommandRefusal(purged)) throw new Error(`purge refused ${purged.code}`);
        expect(Number(purged.detail['purged'])).toBeGreaterThanOrEqual(1);

        const gone = await db.app.withBusiness(business, async (tx) =>
          tx.query<{ readonly count: string }>(
            `select count(*)::text as count from records where business_id = $1 and id = $2`,
            [business, doomed.recordId],
          ),
        );
        expect(gone[0]?.count).toBe('0');

        // The record is gone and what was done to it is not.
        const history = await db.app.withBusiness(business, async (tx) =>
          readRecordAudit(tx, doomed.recordId ?? ''),
        );
        expect(history.map((event) => event.command)).toStrictEqual(['task.create', 'task.trash']);
        const register = await db.app.withBusiness(business, async (tx) =>
          tx.query<{ readonly count: string }>(
            `select count(*)::text as count from operations
            where business_id = $1 and record_id = $2`,
            [business, doomed.recordId],
          ),
        );
        // One for the create and one for the trash: both attempts named the
        // record, and both rows still name it after it is gone.
        expect(register[0]?.count).toBe('2');
      });

      it('refuses a second trash of a subtree already in the trash', async () => {
        const root = await create({ title: 'already gone' });
        const first = await run({
          command: 'task.trash',
          operationId: randomUUID(),
          recordId: root.recordId ?? '',
          expectedRevision: root.revision ?? 0,
        });
        if (isCommandRefusal(first)) throw new Error('trash refused');
        const again = await run({
          command: 'task.trash',
          operationId: randomUUID(),
          recordId: root.recordId ?? '',
          expectedRevision: first.revision ?? 0,
        });
        expect(isCommandRefusal(again) && again.code).toBe('ALREADY_TRASHED');
      });
    });

    describe('revocation bites on the next command', () => {
      it('refuses the next call after the grant is revoked, in the same session', async () => {
        const made = await create({ title: 'revoked mid-flight' });
        await db.app.withBusiness(business, async (tx) => {
          await revokeGrant(tx, grants['write'] ?? '');
        });
        const refusal = await run({
          command: 'task.update',
          operationId: randomUUID(),
          recordId: made.recordId ?? '',
          expectedRevision: made.revision ?? 0,
          fields: { title: 'too late' },
        });
        expect(isCommandRefusal(refusal) && refusal.code).toBe('SCOPE_NOT_GRANTED');
      });
    });
  },
);
