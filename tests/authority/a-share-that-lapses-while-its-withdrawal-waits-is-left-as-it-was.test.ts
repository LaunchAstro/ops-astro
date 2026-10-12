// SPDX-License-Identifier: AGPL-3.0-only
//
// Withdrawing a share counts and revokes the shares still live when it reads
// them, not those live when its transaction began. A withdrawal that waits on
// a lock (the product's waits on the task row its envelope locks) and whose
// share lapses during that wait finds nothing live: it answers 0 and leaves
// the lapsed share as it was, expired and unrevoked.
//
// A fixture transaction holds the task row. The withdrawal begins, takes that
// row in its turn and waits; the share lapses while it waits; then the fixture
// lets go.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { revokeShare, shareRecord } from '../../packages/core-records/src/authority/shares.ts';
import { connect, type TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'a-share-that-lapses-while-its-withdrawal-waits-is-left-as-it-was: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Request = Parameters<typeof executeCommand>[4];

const lockTask = async (tx: TenantQuery, taskId: string): Promise<void> => {
  await tx.query('select id from public.records where business_id = $1 and id = $2 for update', [
    tx.businessId,
    taskId,
  ]);
};

let db: FreshDatabase;
let business: string;
let ada: Member;
let ext: Member;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'sharelapse' });
  business = await insertBusiness(db.app, 'share-lapses-in-wait');
  await installSpine(db.app, business);
  ada = await enrol(db.app, business, 'ada');
  ext = await enrol(db.app, business, 'ext');
  await db.app.withBusiness(business, async (tx) => {
    await grantTo(tx, ada, 'write');
    await grantTo(tx, ada, 'share');
  });
}, 60_000);

afterAll(async () => {
  await db?.drop();
});

/** Withdraw the share while a task lock holds the withdrawal, and let the share lapse meanwhile. */
async function withdrawWhileItLapses(
  taskId: string,
  request: { readonly collection: string; readonly recordId: string; readonly personId: string },
  grantId: string,
): Promise<{ readonly withdrawn: unknown; readonly revoked: boolean | undefined }> {
  const withdrawer = connect(db.appUrl);
  try {
    const blocker = await hold(db.appUrl, business, async (tx) => await lockTask(tx, taskId));
    let withdrawing: Promise<unknown> | undefined;
    try {
      withdrawing = withdrawer.withBusiness(business, async (tx) => {
        await lockTask(tx, taskId);
        return await revokeShare(tx, ada, request);
      });
      await waitingOn(db.admin, 'transactionid', 'from public.records');
      await db.admin.execute(
        'update public.grants set expires_at = clock_timestamp() where id = $1',
        [grantId],
      );
    } finally {
      await blocker.letGo();
    }
    const withdrawn = await withdrawing;
    const after = await db.admin.execute<{ readonly revoked: boolean }>(
      'select revoked_at is not null as revoked from public.grants where id = $1',
      [grantId],
    );

    return { withdrawn, revoked: after[0]?.revoked };
  } finally {
    await withdrawer.close();
  }
}

const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

it('a share that lapses while its withdrawal waits on a lock is not withdrawn and stays as it was', async () => {
  const made = await executeCommand(db.app, business, ada.presented, 'api', {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title: 'shared' },
  } as unknown as Request);
  if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
  const taskId = made.recordId ?? '';
  const request = { collection: 'task', recordId: taskId, personId: ext.personId };
  const shared = await db.app.withBusiness(
    business,
    async (tx) => await shareRecord(tx, ada, request),
  );
  if (!shared.ok) throw new Error(`share refused ${shared.refusal.code}`);

  const { withdrawn, revoked } = await withdrawWhileItLapses(taskId, request, shared.value);
  expect({ withdrawn, revoked }).toEqual({
    withdrawn: { ok: true, value: 0 },
    revoked: false,
  });
});
