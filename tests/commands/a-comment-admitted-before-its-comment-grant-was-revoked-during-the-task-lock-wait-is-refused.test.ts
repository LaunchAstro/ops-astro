// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.comment` asks the caller's comment grant before it locks the task row
// (`prepareCommand`), and asks nothing after. The commenter's only grant is
// `comment` on one task of client A. A fixture transaction holds the task row;
// the comment is admitted on the live grant and parks on the row; the grant is
// revoked and commits; then the fixture lets go. The comment must be refused
// `SCOPE_NOT_GRANTED`, and no comment is written.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
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
  revisionOf,
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

/** `lockTask`'s statement, the one the comment waits in. */
const LOCK_TASK = 'revision::text as revision, data, deleted_at, trash_batch_id';

it.skipIf(serverUrl === undefined)(
  'a comment admitted before its comment grant was revoked during the task lock wait is refused, and writes nothing',
  async () => {
    const task = await taskFor(alpha, owner, 'Comment after revocation', clientA);
    const commenter = await person('revoked-commenter');
    const grantId = await db.app.withBusiness(
      alpha,
      async (tx) => await grantTo(tx, commenter, 'comment', { kind: 'record', id: task }),
    );
    const body = `after revocation ${randomUUID()}`;
    const revision = await revisionOf(task);
    const author = connect(db.appUrl);
    const revoker = connect(db.appUrl);
    try {
      const row = await hold(db.appUrl, alpha, async (tx) => {
        await tx.query(
          'select id from public.records where business_id = $1 and id = $2 for update',
          [tx.businessId, task],
        );
      });
      let commenting: ReturnType<typeof executeCommand> | undefined;
      try {
        commenting = executeCommand(author, alpha, commenter.presented, 'api', {
          command: 'task.comment',
          operationId: randomUUID(),
          recordId: task,
          expectedRevision: revision,
          body,
          audience: 'internal',
        });
        await waitingOn(db.admin, 'transactionid', LOCK_TASK);
        await revoker.withBusiness(alpha, async (tx) => {
          expect(await revokeGrant(tx, grantId)).not.toBeNull();
        });
      } finally {
        await row.letGo();
      }
      const answer = await commenting;
      const written = await db.admin.execute(
        `select id from public.records where business_id = $1 and data ->> 'body' = $2`,
        [alpha, body],
      );
      expect({
        answer: outcomeOf(answer)['code'] ?? 'applied',
        comments: written.length,
      }).toEqual({ answer: 'SCOPE_NOT_GRANTED', comments: 0 });
    } finally {
      await Promise.all([author.close(), revoker.close()]);
    }
  },
);
