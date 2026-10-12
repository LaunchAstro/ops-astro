// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.launch` runs an agent its launcher does not own only on a
// business-wide `agent:assign` (`authority/agents.ts`). That grant is judged
// again after the command's last wait, the business's audit-chain lock, so
// one that expires while the command waits there no longer counts: the launch
// is refused `SCOPE_NOT_GRANTED`, and no launch and no delegation are kept.
// The owner launches their own agent across the same wait, needing no grant.
//
// The audit-chain lock (`business_id::text`, lower case) is held on another
// connection, which locks no record or grant; the launch is seen waiting on
// that holder while the database clock is still before the grant's expiry;
// the holder lets go once the clock is past it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { blockedBefore, hold, instantOf, waitPast } from '../support/lock-wait-race.ts';
import { codeOf } from './agent-fixture.ts';
import {
  aiWorld,
  assign,
  created,
  directsEvery,
  launch,
  ownedAgent,
  type AiWorld,
} from './ai-assign-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('launch grant timing: DATABASE_URL is unset.');

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await aiWorld('launchgrant');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

/** P's business-wide `agent:assign`, lapsing three seconds from now; its expiry as the database holds it. */
async function lapsingDirector(): Promise<string> {
  const grant = await directsEvery(w, w.p);
  await w.world.db.admin.execute(
    `update public.grants set expires_at = clock_timestamp() + interval '3 seconds' where id = $1`,
    [grant],
  );
  return await instantOf(
    w.world.db,
    'select expires_at::text as at from public.grants where id = $1',
    [grant],
  );
}

/** Q's task, held by an agent Q owns. */
async function heldByQsAgent(title: string): Promise<string> {
  const task = await created(w, w.q, title);
  const agent = await ownedAgent(w, w.q);
  expect(codeOf(await assign(w, w.q, task, { agent }))).toBe('not-a-refusal');
  return task;
}

/** Runs `launching` while the audit chain is held past `expiry`; whether it parked before expiry. */
async function acrossExpiry(expiry: string, launching: () => Promise<string>) {
  const held = await hold(w.world.db, async (execute) => {
    await execute('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      w.world.business.toLowerCase(),
    ]);
  });
  const answer = launching();
  let parkedLive = false;
  try {
    parkedLive = await blockedBefore(w.world.db, held, expiry);
    await waitPast(w.world.db, expiry);
  } finally {
    await held.letGo();
  }
  return { parkedLive, code: await answer };
}

/** The launches and delegations kept for the task. */
async function keptFor(task: string): Promise<{ launches: number; delegations: number }> {
  const [row] = await w.world.db.admin.execute<{ launches: number; delegations: number }>(
    `select (select count(*)::int from public.task_launches where task_id = $1) as launches,
            (select count(*)::int from public.delegations where purpose_scope_id = $1) as delegations`,
    [task],
  );
  return row ?? { launches: -1, delegations: -1 };
}

describe.skipIf(serverUrl === undefined)(
  'launching an agent across its directing grant’s expiry',
  () => {
    it('launching another person’s agent refuses an agent:assign grant that expires while it waits for the audit chain', async () => {
      const task = await heldByQsAgent('Launch another person’s agent');
      const expiry = await lapsingDirector();

      const { parkedLive, code } = await acrossExpiry(
        expiry,
        async () => await launch(w, w.p, task),
      );

      expect({ parkedLive, code, kept: await keptFor(task) }).toStrictEqual({
        parkedLive: true,
        code: 'SCOPE_NOT_GRANTED',
        kept: { launches: 0, delegations: 0 },
      });
    }, 30_000);

    it('the owner launches their own agent across the same wait, needing no grant', async () => {
      const task = await heldByQsAgent('Launch my own agent');
      const expiry = await lapsingDirector();

      const { parkedLive, code } = await acrossExpiry(
        expiry,
        async () => await launch(w, w.q, task),
      );

      expect({ parkedLive, code, kept: await keptFor(task) }).toStrictEqual({
        parkedLive: true,
        code: 'not-a-refusal',
        kept: { launches: 1, delegations: 1 },
      });
    }, 30_000);
  },
);
