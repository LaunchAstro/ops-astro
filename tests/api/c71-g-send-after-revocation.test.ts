// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { executeCommand, executeRead } from '../../packages/core-commands/src/index.ts';
import { connect } from '../../packages/core-records/src/index.ts';
import { lockConversation } from '../../packages/core-records/src/team/conversations.ts';
import type { Answer } from '../acceptance/world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createGroupWorld, type GroupWorld } from './c71-g-world.ts';

const settled = (): void => {
  // Cleanup waits for each call to finish; a case's own assertions read its outcome.
};

/** How many backends in this database wait on an advisory lock right now. */
async function advisoryWaiters(world: GroupWorld['chat']['harness']['world']): Promise<number> {
  const [row] = await world.db.admin.execute<{ n: string }>(
    `select count(*)::text as n from pg_stat_activity
      where datname = $1 and wait_event_type = 'Lock' and wait_event = 'advisory'`,
    [world.db.name],
  );
  return Number(row?.n ?? 0);
}

// Writes are judged under the access lock revocations take (OWNER-3 A,
// `prepare.ts`): a group send holds it shared from its judgement, through its
// wait on the conversation lock, to its commit. So a revocation of the
// sender's chat authority waits behind a send already queued, the send lands
// as judged, and every send after the revocation is refused and writes nothing.
// eslint-disable-next-line max-lines-per-function -- one controlled interleaving and its cleanup
// Needs a database; skipped where the suite runs without one, as its siblings are.
it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'C71-G a revocation waits for a group send already queued on the conversation lock, and every send after it is refused',
  async () => {
    const g = await createGroupWorld('sol357sender');
    const { world } = g.chat.harness;
    const writer = connect(world.db.appUrl);
    const revoker = connect(world.db.appUrl);
    const queued = 'Queued before the revocation';
    const after = 'Sent after the revocation';
    let sending: Promise<Answer> | undefined;
    let revoking: Promise<unknown> | undefined;
    try {
      const [grant] = await world.db.admin.execute<{ id: string }>(
        `select id from public.grants where business_id = $1 and subject_id = $2
          and collection = 'chat' and action = 'comment' and revoked_at is null`,
        [world.alpha, world.mia.personId],
      );
      expect(grant).toBeDefined();
      await writer.withBusiness(world.alpha, async (tx) => {
        await lockConversation(tx, g.conversationId);
        sending = g.as(world.mia, 'chat.send_group', {
          conversationId: g.conversationId,
          body: queued,
        });
        await expect.poll(async () => await advisoryWaiters(world), { timeout: 5_000 }).toBe(1);
        revoking = executeCommand(revoker, world.alpha, world.ada.presented, 'api', {
          command: 'access.revoke',
          operationId: randomUUID(),
          grantId: String(grant?.id),
        });
        // The revocation queues behind the send's shared access lock.
        await expect.poll(async () => await advisoryWaiters(world), { timeout: 5_000 }).toBe(2);
      });
      expect((await sending)?.code).toBe('ok');
      expect(await revoking).not.toHaveProperty('refused');
      expect(await g.bodiesOf(world.ada)).toContain(queued);
      expect(
        await executeRead(revoker, world.alpha, world.mia.presented, {
          read: 'chat.messages',
          conversationId: g.conversationId,
        }),
      ).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
      const refused = await g.as(world.mia, 'chat.send_group', {
        conversationId: g.conversationId,
        body: after,
      });
      expect(refused.code, refused.text).toBe('SCOPE_NOT_GRANTED');
      expect(await g.bodiesOf(world.ada)).not.toContain(after);
      const written = await world.db.admin.execute(
        `select i.id from public.inbox_items i join public.records c
        on c.business_id = i.business_id and c.id = i.fact_id
       where i.business_id = $1 and c.data ->> 'body' = $2`,
        [world.alpha, after],
      );
      expect(written).toEqual([]);
    } finally {
      await sending?.catch(settled);
      await revoking?.catch(settled);
      await writer.close();
      await revoker.close();
      await g.chat.harness.close();
    }
  },
  60_000,
);
