// SPDX-License-Identifier: AGPL-3.0-only
//
// `stampSeen` asks whether the recipient can read the item's task, then
// inserts their attention row. The insert waits on any other transaction
// writing that item's attention row. A fixture transaction writes it and holds
// it; the stamp is admitted on the recipient's live read grant and parks on
// that row; the grant is revoked and commits; the fixture rolls back and lets
// go. The recipient can no longer read the task, so the stamp must answer
// false and leave no attention row.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { taskAccess } from '../../packages/core-records/src/inbox/access.ts';
import { raiseInboxItem, stampSeen } from '../../packages/core-records/src/inbox/items.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { enrol, grantTo, installSpine } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { createTask } from '../tasks/fixture.ts';

const it = databaseUrlFromEnvironment() === undefined ? vitestIt.skip : vitestIt;

/** A business whose reader holds read on one task only, and an open item about it. */
async function seed(db: FreshDatabase) {
  const business = await insertBusiness(db.app, 'seen-revoked');
  const reader = await enrol(db.app, business, 'reader');
  const spine = await installSpine(db.app, business);
  return await db.app.withBusiness(business, async (tx) => {
    const task = await createTask(tx, spine, { title: 'Private task', parentId: null });
    const grant = await grantTo(tx, reader, 'read', { kind: 'record', id: task });
    const item = await raiseInboxItem(tx, {
      recipientPersonId: reader.personId,
      subjectRecordId: task,
      reason: 'mention',
      fact: { kind: 'record', id: randomUUID() },
    });
    return { business, person: reader.personId, task, grant, item };
  });
}

/** Another transaction writing the item's attention row, held until let go and rolled back. */
const otherStamp = async (db: FreshDatabase, business: string, item: string, person: string) =>
  await hold(
    db.appUrl,
    business,
    async (tx) => {
      await tx.query(
        `insert into public.inbox_attention (business_id, item_id, person_id) values ($1, $2, $3)`,
        [tx.businessId, item, person],
      );
    },
    'rollback',
  );

it('a seen stamp admitted before its read grant was revoked during the attention wait writes nothing', async () => {
  const db = await createFreshDatabase({ part: 'seenrevoked' });
  const stamper = connect(db.appUrl);
  const revoker = connect(db.appUrl);
  try {
    const { business, person, task, grant, item } = await seed(db);
    const other = await otherStamp(db, business, item, person);
    let stamping: Promise<boolean> | undefined;
    let access: string | undefined;
    try {
      stamping = stamper.withBusiness(business, async (tx) => await stampSeen(tx, person, item));
      await waitingOn(db.admin, 'transactionid', 'insert into public.inbox_attention');
      access = await revoker.withBusiness(business, async (tx) => {
        expect(await revokeGrant(tx, grant)).not.toBeNull();
        return await taskAccess(tx, person, task);
      });
    } finally {
      await other.letGo();
    }
    const seen = await stamping;
    const rows = await db.admin.execute('select 1 from public.inbox_attention where item_id = $1', [
      item,
    ]);
    expect({ access, seen, attentionRows: rows.length }).toEqual({
      access: 'withheld',
      seen: false,
      attentionRows: 0,
    });
  } finally {
    await Promise.all([stamper.close(), revoker.close()]);
    await db.drop();
  }
});
