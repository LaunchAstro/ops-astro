// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent write asks its person's grant again after its last wait, the
// business audit chain key: a comment grant that runs out while the comment
// waits there refuses it and keeps nothing.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentWorld, codeOf, type AgentWorld } from './agent-fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('an agent write after its audit chain wait', () => {
  let world: AgentWorld;
  beforeAll(async () => {
    world = await agentWorld('sol1475_agent_audit', `sol-${randomUUID().slice(0, 8)}`);
  }, 180_000);
  afterAll(async () => {
    await world?.drop();
  });

  it("an agent comment keeps nothing when its person's grant expires during the audit chain wait", async () => {
    const writer = await world.decider(`writer_${randomUUID()}`);
    const picked = await world.pickUp(writer, 'Expired comment authority');
    await world.db.admin.execute(
      "update public.grants set expires_at = clock_timestamp() + interval '3 seconds' where id = $1",
      [writer.grants.comment],
    );
    const operationId = randomUUID();
    const chain = await hold(world.db.appUrl, world.business, async (tx) => {
      await tx.query('select pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
        world.business,
      ]);
    });
    let posting: ReturnType<AgentWorld['asAgent']> | undefined;
    try {
      posting = world.asAgent(
        {
          command: 'task.comment',
          operationId,
          recordId: picked.taskId,
          audience: 'internal',
          body: 'Must not land after expiry',
        },
        picked.credential,
      );
      await waitingOn(world.db.admin, 'advisory', 'pg_advisory_xact_lock');
      await expect
        .poll(
          async () => {
            const [row] = await world.db.admin.execute<{ expired: boolean }>(
              'select expires_at <= clock_timestamp() as expired from public.grants where id = $1',
              [writer.grants.comment],
            );
            return row?.expired;
          },
          { timeout: 10_000 },
        )
        .toBe(true);
    } finally {
      await chain.letGo();
    }
    const answer = await posting;
    if (answer === undefined) throw new Error('No agent answer');
    expect({ code: codeOf(answer), comments: await world.commentsOn(picked.taskId) }).toEqual({
      code: 'DELEGATION_NARROWED',
      comments: 0,
    });
  }, 30_000);
});
