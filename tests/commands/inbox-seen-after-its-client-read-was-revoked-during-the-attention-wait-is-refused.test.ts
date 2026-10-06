// SPDX-License-Identifier: AGPL-3.0-only
//
// `inbox.seen` asks whether the recipient can read the item's task now, then
// inserts their attention row, which waits on any other transaction writing
// that item's attention row. The recipient reads client A's task through a
// party grant on client A. A fixture transaction writes the attention row and
// holds it; `inbox.seen` is admitted on the live grant and parks on that row;
// the client grant is revoked and commits; the fixture rolls back and lets go.
// The recipient can no longer read the task, so the command must be refused
// `NOT_FOUND`, as an item that is not theirs, and stamp nothing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { raiseInboxItem } from '../../packages/core-records/src/inbox/items.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { grantTo } from './fixture.ts';
import {
  alpha,
  clientA,
  db,
  outcomeOf,
  owner,
  person,
  serverUrl,
  setUp,
  taskFor,
  tearDown,
} from './duplicate-world.ts';

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);
afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

/** Another transaction writing the item's attention row, held until let go and rolled back. */
const otherStamp = async (item: string, recipient: string) =>
  await hold(
    db.appUrl,
    alpha,
    async (tx) => {
      await tx.query(
        `insert into public.inbox_attention (business_id, item_id, person_id) values ($1, $2, $3)`,
        [tx.businessId, item, recipient],
      );
    },
    'rollback',
  );

it.skipIf(serverUrl === undefined)(
  'inbox.seen admitted before its client read grant was revoked during the attention wait is refused, and stamps nothing',
  async () => {
    const task = await taskFor(alpha, owner, 'Client A private task', clientA);
    const reader = await person('client-a-reader');
    const { grant, item } = await db.app.withBusiness(alpha, async (tx) => ({
      grant: await grantTo(tx, reader, 'read', { kind: 'party', id: clientA }),
      item: await raiseInboxItem(tx, {
        recipientPersonId: reader.personId,
        subjectRecordId: task,
        reason: 'mention',
        fact: { kind: 'record', id: randomUUID() },
      }),
    }));
    const stamper = connect(db.appUrl);
    const revoker = connect(db.appUrl);
    try {
      const other = await otherStamp(item, reader.personId);
      let stamping: ReturnType<typeof executeCommand> | undefined;
      try {
        stamping = executeCommand(stamper, alpha, reader.presented, 'api', {
          command: 'inbox.seen',
          operationId: randomUUID(),
          itemId: item,
        });
        await waitingOn(db.admin, 'transactionid', 'insert into public.inbox_attention');
        await revoker.withBusiness(alpha, async (tx) => {
          expect(await revokeGrant(tx, grant)).not.toBeNull();
        });
      } finally {
        await other.letGo();
      }
      const answer = await stamping;
      const rows = await db.admin.execute(
        'select 1 from public.inbox_attention where item_id = $1',
        [item],
      );
      expect({
        answer: outcomeOf(answer)['code'] ?? 'applied',
        attentionRows: rows.length,
      }).toEqual({ answer: 'NOT_FOUND', attentionRows: 0 });
    } finally {
      await Promise.all([stamper.close(), revoker.close()]);
    }
  },
);
