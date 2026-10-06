// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.complete` asks the caller's write grant on the parent, locks the
// parent row, and then locks its unfinished subtasks (`lockSteps`), asking
// each step's own grant. The completer holds independent record grants on the
// parent and on its one subtask, and nothing business-wide. A fixture
// transaction holds the subtask's row; the completion parks on it; the
// parent's grant is revoked through `access.revoke` and commits; then the
// fixture lets go. The completion must be refused `SCOPE_NOT_GRANTED`: the
// parent's state and revision and the subtask's archive fields stay as they
// were (Sol round 1 on #1010, F1).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { grantTo, WHOLE_BUSINESS } from './fixture.ts';
import {
  alpha,
  as,
  clientAWriter,
  db,
  fresh,
  outcomeOf,
  serverUrl,
  setUp,
  tearDown,
  writer,
} from './adhoc-world.ts';

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);
afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

/** `lockSteps`' statement, the one the completion waits in. */
const LOCK_STEPS = 'for update of r';

const state = async (id: string): Promise<Readonly<Record<string, unknown>> | undefined> =>
  (
    await db.admin.execute<Readonly<Record<string, unknown>>>(
      `select data ->> 'state' as state, revision::text as revision,
              data ? 'archived_at' as archived from public.records where id = $1`,
      [id],
    )
  )[0];

it.skipIf(serverUrl === undefined)(
  'a completion whose parent grant was revoked during the subtask lock wait is refused, and moves nothing',
  async () => {
    const parent = await fresh(alpha, writer, 'Parent after revocation');
    const made = await as(alpha, writer, {
      command: 'task.create',
      fields: { title: 'Unfinished step' },
      parentId: parent.recordId,
    });
    const child = String((made as { readonly recordId?: string }).recordId);
    const parentGrant = await db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, writer, 'manage', WHOLE_BUSINESS, false, 'access');
      await grantTo(tx, clientAWriter, 'write', { kind: 'record', id: child });
      return await grantTo(tx, clientAWriter, 'write', { kind: 'record', id: parent.recordId });
    });
    const before = { parent: await state(parent.recordId), child: await state(child) };
    const completer = connect(db.appUrl);
    const revoker = connect(db.appUrl);
    try {
      const row = await hold(db.appUrl, alpha, async (tx) => {
        await tx.query(
          'select id from public.records where business_id = $1 and id = $2 for update',
          [tx.businessId, child],
        );
      });
      let completing: ReturnType<typeof executeCommand> | undefined;
      try {
        completing = executeCommand(completer, alpha, clientAWriter.presented, 'api', {
          command: 'task.complete',
          operationId: randomUUID(),
          recordId: parent.recordId,
          expectedRevision: Number(before.parent?.['revision']),
        });
        await waitingOn(db.admin, 'transactionid', LOCK_STEPS);
        const revoked = await executeCommand(revoker, alpha, writer.presented, 'api', {
          command: 'access.revoke',
          operationId: randomUUID(),
          grantId: parentGrant,
        });
        expect(outcomeOf(revoked)).toEqual({ applied: true });
      } finally {
        await row.letGo();
      }
      const answer = await completing;
      expect({
        answer: outcomeOf(answer)['code'] ?? 'applied',
        parent: await state(parent.recordId),
        child: await state(child),
      }).toEqual({ answer: 'SCOPE_NOT_GRANTED', ...before });
    } finally {
      await Promise.all([completer.close(), revoker.close()]);
    }
  },
);
