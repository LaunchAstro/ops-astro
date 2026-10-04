// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import { connect, type Database } from '../../packages/core-records/src/index.ts';
import { createGroupWorld } from './c71-g-world.ts';

function latch() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release?.() };
}

// eslint-disable-next-line max-lines-per-function -- one controlled interleaving and its cleanup
it('a messages read under way when chat access is revoked serves no message written after', async () => {
  const g = await createGroupWorld('c71msgrevoke');
  const { world } = g.chat.harness;
  const reader = connect(world.db.appUrl);
  const reached = latch();
  const resume = latch();
  const paused: Database = {
    log: reader.log,
    close: () => reader.close(),
    withBusiness: (business, run) =>
      reader.withBusiness(business, (tx) =>
        run({
          ...tx,
          async query<Row>(
            statement: string,
            parameters?: readonly unknown[],
          ): Promise<readonly Row[]> {
            if (statement.includes('p.display_name as author')) {
              reached.release();
              await resume.promise;
            }
            return await tx.query<Row>(statement, parameters);
          },
        }),
      ),
  };
  let reading: ReturnType<typeof executeRead> | undefined;
  try {
    reading = executeRead(paused, world.alpha, world.mia.presented, {
      read: 'chat.messages',
      conversationId: g.conversationId,
    });
    await reached.promise;
    const [grant] = await world.db.admin.execute<{ id: string }>(
      `select id from public.grants where business_id = $1 and subject_id = $2
         and collection = 'chat' and action = 'comment' and revoked_at is null`,
      [world.alpha, world.mia.personId],
    );
    const revoked = await g.as(world.ada, 'access.revoke', { grantId: grant?.id });
    expect(revoked.status, revoked.text).toBe(200);
    const after = 'Group message written after chat access was revoked';
    expect((await g.say(g.chat.tess, after)).status).toBe(200);
    expect(
      (await g.as(world.mia, 'chat.messages', { conversationId: g.conversationId })).text,
    ).not.toContain(after);
    resume.release();
    expect(JSON.stringify(await reading)).not.toContain(after);
  } finally {
    resume.release();
    await reading;
    await reader.close();
    await g.chat.harness.close();
  }
}, 180_000);
