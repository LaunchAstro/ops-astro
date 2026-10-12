// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { shareRecord } from '../../packages/core-records/src/authority/shares.ts';
import { advisoryLock, connect } from '../../packages/core-records/src/tenancy/database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';

const serverUrl = databaseUrlFromEnvironment();
const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

let db: FreshDatabase;
let business: string;
let sharer: Member;
let recipient: Member;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'sol1362' });
  business = await insertBusiness(db.app, 'sol-share-standing');
  await installSpine(db.app, business);
  sharer = await enrol(db.app, business, 'sharer');
  recipient = await enrol(db.app, business, 'recipient');
  await db.app.withBusiness(business, async (tx) => await grantTo(tx, sharer, 'write'));
});

afterAll(async () => await db?.drop());

it.each(['expires', 'is revoked'] as const)(
  'shareRecord refuses a share grant that %s during the new share lock wait',
  // eslint-disable-next-line max-lines-per-function -- a proof kept as its reviewer wrote it
  async (ending) => {
    const made = await executeCommand(db.app, business, sharer.presented, 'api', {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'share race' },
    });
    if (isCommandRefusal(made) || made.recordId === undefined) throw new Error('create failed');
    const recordId = String(made.recordId);
    const grantId = await db.app.withBusiness(
      business,
      async (tx) => await grantTo(tx, sharer, 'share', { kind: 'record', id: recordId }),
    );
    const request = { collection: 'task', recordId, personId: recipient.personId };
    const key = `record-share:${business}:${recordId}:${recipient.personId}`.toLowerCase();
    const blocker = await hold(db.appUrl, business, async (tx) => await advisoryLock(tx, key));
    const caller = connect(db.appUrl);
    const sent = caller.withBusiness(
      business,
      async (tx) => await shareRecord(tx, sharer, request),
    );
    try {
      await waitingOn(db.admin, 'advisory', 'pg_advisory_xact_lock');
      if (ending === 'expires') {
        await db.admin.execute(
          'update public.grants set expires_at = clock_timestamp() where id = $1',
          [grantId],
        );
      } else {
        await db.admin.execute(
          'update public.grants set revoked_at = clock_timestamp() where id = $1',
          [grantId],
        );
      }
    } finally {
      await blocker.letGo();
    }
    try {
      const answer = await sent;
      const [row] = await db.admin.execute<{ readonly n: number }>(
        `select count(*)::int as n from public.grants
          where business_id = $1 and subject_id = $2 and scope_id = $3
            and collection = 'task' and action = 'read' and revoked_at is null`,
        [business, recipient.personId, recordId],
      );
      expect({ refused: !answer.ok, createdShares: row?.n }).toEqual({
        refused: true,
        createdShares: 0,
      });
    } finally {
      await caller.close();
    }
  },
);
