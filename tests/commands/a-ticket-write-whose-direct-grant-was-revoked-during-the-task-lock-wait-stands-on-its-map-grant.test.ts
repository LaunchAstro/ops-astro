// SPDX-License-Identifier: AGPL-3.0-only
//
// A write on a map's ticket is admitted on the caller's grant on the ticket,
// or, failing that, on its grant on the covering map (W12), and both are asked
// again once the ticket row is held (`prepareCommand`). The writer holds
// independent write grants on the ticket and on its map. A fixture
// transaction holds the ticket row; the edit parks on it; the ticket grant is
// revoked through `access.revoke` and commits, the map grant left live; then
// the fixture lets go. The edit must still apply, once, on the map's grant: a
// retry with the same revision is then stale (Sol round 1 on #1010, F4).

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
  outcomeOf,
  row,
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

/** `lockTask`'s statement, the one the edit waits in. */
const LOCK_TASK = 'revision::text as revision, data, deleted_at, trash_batch_id';

const created = async (body: Record<string, unknown>): Promise<string> => {
  const made = await as(alpha, writer, { command: 'task.create', ...body });
  const id = (made as { readonly recordId?: string }).recordId;
  if (id === undefined) throw new Error(`create refused ${JSON.stringify(made)}`);
  return id;
};

it.skipIf(serverUrl === undefined)(
  'a ticket write whose direct grant was revoked during the task lock wait stands on its map grant, once',
  async () => {
    const map = await created({ fields: { title: 'Map' }, taskType: 'map' });
    const ticket = await created({ fields: { title: 'Ticket' }, parentId: map });
    const ticketGrant = await db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, writer, 'manage', WHOLE_BUSINESS, false, 'access');
      await grantTo(tx, clientAWriter, 'write', { kind: 'record', id: map });
      return await grantTo(tx, clientAWriter, 'write', { kind: 'record', id: ticket });
    });
    const revision = Number((await row(ticket))?.revision);
    const edit = {
      command: 'task.update',
      recordId: ticket,
      expectedRevision: revision,
      fields: { title: 'Ticket, edited' },
    };
    const editor = connect(db.appUrl);
    const revoker = connect(db.appUrl);
    try {
      const held = await hold(db.appUrl, alpha, async (tx) => {
        await tx.query(
          'select id from public.records where business_id = $1 and id = $2 for update',
          [tx.businessId, ticket],
        );
      });
      let editing: ReturnType<typeof executeCommand> | undefined;
      try {
        editing = executeCommand(editor, alpha, clientAWriter.presented, 'api', {
          ...edit,
          operationId: randomUUID(),
        } as never);
        await waitingOn(db.admin, 'transactionid', LOCK_TASK);
        const revoked = await executeCommand(revoker, alpha, writer.presented, 'api', {
          command: 'access.revoke',
          operationId: randomUUID(),
          grantId: ticketGrant,
        });
        expect(outcomeOf(revoked)).toEqual({ applied: true });
      } finally {
        await held.letGo();
      }
      const answer = await editing;
      const retry = await executeCommand(editor, alpha, clientAWriter.presented, 'api', {
        ...edit,
        operationId: randomUUID(),
      } as never);
      const [stored] = await db.admin.execute<{
        readonly title: string;
        readonly revision: number;
      }>(
        "select data ->> 'title' as title, revision::int as revision from public.records where id = $1",
        [ticket],
      );
      expect({
        answer: outcomeOf(answer)['code'] ?? 'applied',
        retry: outcomeOf(retry)['code'] ?? 'applied',
        stored,
      }).toEqual({
        answer: 'applied',
        retry: 'VERSION_STALE',
        stored: { title: 'Ticket, edited', revision: revision + 1 },
      });
    } finally {
      await Promise.all([editor.close(), revoker.close()]);
    }
  },
);
