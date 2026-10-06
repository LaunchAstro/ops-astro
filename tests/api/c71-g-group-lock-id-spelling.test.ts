// SPDX-License-Identifier: AGPL-3.0-only
//
// C71-G: a group send and a member removal serialise on the conversation's
// lock whatever the letter case of the id the send names. The send is paused
// at its write, the sender removed, and the message must still be stamped
// before the removal.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import type { TransactionQuery } from '../../packages/core-records/src/tenancy/transaction.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createGroupWorld, detailOf, type GroupWorld } from './c71-g-world.ts';

function signal() {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- replaced synchronously by this promise's resolver
  let fire = () => {};
  const fired = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { fired, fire };
}

async function waitForRemoval(g: GroupWorld, finished: () => boolean): Promise<void> {
  const { db } = g.chat.harness.world;
  for (let n = 0; n < 200; n += 1) {
    if (finished()) return;
    // oxlint-disable-next-line no-await-in-loop -- observe each step until removal finishes or blocks
    const rows = await db.admin.execute<{ readonly blocked: boolean }>(
      `select exists (select 1 from pg_stat_activity
        where datname = current_database() and wait_event = 'advisory'
          and query like '%pg_advisory_xact_lock%') as blocked`,
    );
    if (rows[0]?.blocked === true) return;
    // oxlint-disable-next-line no-await-in-loop -- yield before the next observation
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error('removal neither completed nor waited for the conversation lock');
}

/** A send whose transaction pauses at its message write until released. */
function pausedSend(g: GroupWorld, conversationId: string, body: string) {
  const { world } = g.chat.harness;
  const own = connect(world.db.appUrl);
  const reachedWrite = signal();
  const release = signal();
  const scheduled: Database = {
    ...own,
    withBusiness: async (businessId, run) =>
      await own.withBusiness(businessId, async (tx) => {
        const gated: TransactionQuery = {
          ...tx,
          query: async <Row>(sql: string, parameters: readonly unknown[] = []) => {
            if (sql.startsWith('insert into records') && parameters[6] === 'group') {
              reachedWrite.fire();
              await release.fired;
            }
            return await tx.query<Row>(sql, parameters);
          },
        };
        return await run(gated);
      }),
  };
  const sent = executeCommand(scheduled, world.alpha, world.mia.presented, 'api', {
    command: 'chat.send_group',
    operationId: randomUUID(),
    conversationId,
    body,
  });
  return { own, reachedWrite, release, sent };
}

/** Whether the message with this body is stamped at or before Mia's removal. */
async function stampedBeforeRemoval(g: GroupWorld, body: string): Promise<boolean | undefined> {
  const { world } = g.chat.harness;
  const [row] = await world.db.admin.execute<{ readonly before_removal: boolean }>(
    `select c.ts_1 <= m.left_at as before_removal from public.records c
    join public.team_conversation_members m on m.business_id = c.business_id
      and m.conversation_id = c.uuid_4 and m.person_id = $2
   where c.business_id = $1 and c.data ->> 'body' = $3`,
    [world.alpha, world.mia.personId, body],
  );
  return row?.before_removal;
}

/** Mia's send paused at its write, Tess removes her, then the send goes on. */
async function sendAcrossRemoval(g: GroupWorld, upper: boolean): Promise<void> {
  const { world } = g.chat.harness;
  const started = await g.start(g.chat.tess, [world.ada.personId, world.mia.personId]);
  expect(started.status, started.text).toBe(200);
  const conversationId = String(detailOf(started)['conversationId']);
  const body = `post-removal-${randomUUID()}`;
  const paused = pausedSend(g, upper ? conversationId.toUpperCase() : conversationId, body);
  let removalFinished = false;
  let removed: ReturnType<GroupWorld['as']> | undefined;
  try {
    await paused.reachedWrite.fired;
    removed = g
      .as(g.chat.tess, 'chat.change_members', { conversationId, remove: [world.mia.personId] })
      .then((answer) => {
        removalFinished = true;
        return answer;
      });
    await waitForRemoval(g, () => removalFinished);
    paused.release.fire();
    const [send, removal] = await Promise.all([paused.sent, removed]);
    expect(removal.status, removal.text).toBe(200);
    expect(send).not.toHaveProperty('refused');
    expect(await stampedBeforeRemoval(g, body), 'an applied member send must precede removal').toBe(
      true,
    );
  } finally {
    paused.release.fire();
    await paused.sent;
    await removed;
    await paused.own.close();
  }
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)('C71-G group lock', () => {
  let g: GroupWorld;
  beforeAll(async () => {
    g = await createGroupWorld('glock');
  }, 180_000);
  afterAll(async () => {
    await g?.chat.harness.close();
  });

  it.each([
    { spelling: 'identical lower-case', upper: false },
    { spelling: 'upper-case and lower-case', upper: true },
  ])(
    'C71-G $spelling group ids serialise a send against removal',
    async ({ upper }) => {
      await sendAcrossRemoval(g, upper);
    },
    60_000,
  );
});
