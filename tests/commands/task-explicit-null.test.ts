// SPDX-License-Identifier: AGPL-3.0-only
//
// What `task.update` does with an explicit null, as the legacy did: the field
// is cleared, and a field the payload leaves out is left alone.
//
// Split from `task-lifecycle.test.ts`, which holds the lifecycle, the
// placement and the board, with the same fixture: a fresh database, one
// business with the task spine, and a worker holding write, assign, share and
// manage.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'task explicit null: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

let db: FreshDatabase;
let business: string;
let worker: Member;

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

const read = async (recordId: string) =>
  await db.app.withBusiness(business, async (tx) => {
    const rows = await tx.query<{
      readonly data: Record<string, unknown>;
      readonly revision: string;
      readonly ts_2: Date | null;
      readonly uuid_5: string | null;
      readonly uuid_6: string | null;
    }>(
      `select data, revision::text as revision, ts_2, uuid_5, uuid_6 from records
        where business_id = $1 and id = $2`,
      [business, recordId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('read: gone');
    return row;
  });

describe.skipIf(serverUrl === undefined)(
  'the task commands: a field cleared by an explicit null, and one left out',
  () => {
    beforeAll(async () => {
      db = await createFreshDatabase({ part: 'f' });
      business = await insertBusiness(db.app, 'task-commands');
      await installSpine(db.app, business);
      worker = await enrol(db.app, business, 'worker');
      await db.app.withBusiness(business, async (tx) => {
        await grantTo(tx, worker, 'write');
        await grantTo(tx, worker, 'assign');
        await grantTo(tx, worker, 'share');
        await grantTo(tx, worker, 'manage');
      });
    }, 60_000);

    afterAll(async () => {
      await db?.drop();
    });

    describe('the explicit null the legacy had', () => {
      it('clears a field on an explicit null and leaves an absent one alone', async () => {
        const made = await create({ title: 'dated', due: new Date(0).toISOString(), priority: 3 });
        const cleared = await run({
          command: 'task.update',
          operationId: randomUUID(),
          recordId: made.recordId ?? '',
          expectedRevision: made.revision ?? 0,
          fields: { due: null },
        });
        if (isCommandRefusal(cleared)) throw new Error('update refused');
        const row = await read(made.recordId ?? '');
        expect('due' in row.data).toBe(false);
        expect(row.data['priority']).toBe(3);
      });
    });
  },
);
