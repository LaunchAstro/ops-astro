// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.set_category` asks the caller's write grant, waits for the task row
// (`prepareCommand`), and asks again once it holds it. The writer's only write is a
// grant on this one task. A fixture transaction holds the task row; the set is
// admitted on the live grant and parks on the row; the grant is revoked and
// commits; then the fixture lets go. The set must be refused
// `SCOPE_NOT_GRANTED`, and the task's category and revision stay as they were.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { grantTo } from './fixture.ts';
import {
  alpha,
  clientAWriter,
  db,
  fresh,
  outcomeOf,
  serverUrl,
  setUp,
  tearDown,
  writer,
} from './adhoc-world.ts';
import { stored } from './category-support.ts';

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);
afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

/** `lockTask`'s statement, the one the set waits in. */
const LOCK_TASK = 'revision::text as revision, data, deleted_at, trash_batch_id';

it.skipIf(serverUrl === undefined)(
  'a category set admitted before its write grant was revoked during the task lock wait is refused, and writes nothing',
  async () => {
    const task = await fresh(alpha, writer, 'Category after revocation');
    const grantId = await db.app.withBusiness(
      alpha,
      async (tx) =>
        await grantTo(tx, clientAWriter, 'write', { kind: 'record', id: task.recordId }),
    );
    const setter = connect(db.appUrl);
    const revoker = connect(db.appUrl);
    try {
      const row = await hold(db.appUrl, alpha, async (tx) => {
        await tx.query(
          'select id from public.records where business_id = $1 and id = $2 for update',
          [tx.businessId, task.recordId],
        );
      });
      let setting: ReturnType<typeof executeCommand> | undefined;
      try {
        setting = executeCommand(setter, alpha, clientAWriter.presented, 'api', {
          command: 'task.set_category',
          operationId: randomUUID(),
          recordId: task.recordId,
          expectedRevision: task.revision,
          fields: { category: 'seo' },
        });
        await waitingOn(db.admin, 'transactionid', LOCK_TASK);
        await revoker.withBusiness(alpha, async (tx) => {
          expect(await revokeGrant(tx, grantId)).not.toBeNull();
        });
      } finally {
        await row.letGo();
      }
      const answer = await setting;
      expect({
        answer: outcomeOf(answer)['code'] ?? 'applied',
        stored: await stored(task.recordId),
      }).toEqual({
        answer: 'SCOPE_NOT_GRANTED',
        stored: { category: null, revision: task.revision },
      });
    } finally {
      await Promise.all([setter.close(), revoker.close()]);
    }
  },
);
