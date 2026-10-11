// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.assign` hands a task to an agent its assigner does not own only on a
// business-wide `agent:assign` (`authority/agents.ts`). That grant is judged
// again after the command's last wait, the business's audit-chain lock, so
// one that expires while the command waits there no longer counts: the
// assignment is refused `SCOPE_NOT_GRANTED` and the task keeps nothing.
// Another person's live grant does not stand in for it, nor does a live one
// naming the same person id in another business. The owner needs no grant.
//
// The audit-chain lock (`business_id::text`, lower case) is held on another
// connection, which locks no record or grant; the assignment is seen waiting
// on that holder while the database clock is still before the grant's
// expiry; the holder lets go once the clock is past it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { blockedBefore, hold, instantOf, waitPast } from '../support/lock-wait-race.ts';
import { codeOf } from './agent-fixture.ts';
import { enrol, grantTo } from './fixture.ts';
import {
  aiWorld,
  assign,
  assignEvents,
  created,
  directsEvery,
  holder,
  ownedAgent,
  revisionOf,
  type AiWorld,
} from './ai-assign-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('agent-assign grant timing: DATABASE_URL is unset.');

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await aiWorld('aigrant');
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

/** Live `agent:assign` that is not P's here: Q's, and one naming P's person id in another business. */
async function othersDirecting(): Promise<void> {
  await directsEvery(w, w.q);
  const bravo = await insertBusiness(w.world.db.app, `aig-b-${randomUUID().slice(0, 8)}`);
  const there = await enrol(w.world.db.app, bravo, 'there');
  await w.world.db.app.withBusiness(bravo, async (tx) => {
    await grantTo(tx, { ...there, personId: w.p.personId }, 'assign', undefined, false, 'agent');
  });
}

/** The business's audit-chain lock, taken as the chain takes it, on a connection of its own. */
async function holdAuditChain() {
  return await hold(w.world.db, async (execute) => {
    await execute('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      w.world.business.toLowerCase(),
    ]);
  });
}

/** Runs `assigning` while the audit chain is held past `expiry`; whether it parked before expiry. */
async function acrossExpiry<T>(expiry: string, assigning: () => Promise<T>) {
  const held = await holdAuditChain();
  const answer = assigning();
  let parkedLive = false;
  try {
    parkedLive = await blockedBefore(w.world.db, held, expiry);
    await waitPast(w.world.db, expiry);
  } finally {
    await held.letGo();
  }
  return { parkedLive, answer: await answer };
}

describe.skipIf(serverUrl === undefined)(
  'assigning an agent across its directing grant’s expiry',
  () => {
    it('assigning another person’s agent refuses an agent:assign grant that expires while it waits for the audit chain', async () => {
      const task = await created(w, w.p, 'Hand to another person’s agent');
      const agent = await ownedAgent(w, w.q);
      await othersDirecting();
      const expiry = await lapsingDirector();
      const revision = await revisionOf(w, task);

      const { parkedLive, answer } = await acrossExpiry(
        expiry,
        async () => await assign(w, w.p, task, { agent }),
      );

      expect({
        parkedLive,
        code: codeOf(answer),
        holder: await holder(w, task),
        revision: await revisionOf(w, task),
        applied: await assignEvents(w, task),
      }).toStrictEqual({
        parkedLive: true,
        code: 'SCOPE_NOT_GRANTED',
        holder: { agent: null, person: null },
        revision,
        applied: 0,
      });
    }, 30_000);

    it('the owner assigns their own agent across the same wait, needing no grant', async () => {
      const task = await created(w, w.p, 'Hand to my own agent');
      const agent = await ownedAgent(w, w.p);
      const expiry = await lapsingDirector();

      const { parkedLive, answer } = await acrossExpiry(
        expiry,
        async () => await assign(w, w.p, task, { agent }),
      );

      expect({ parkedLive, code: codeOf(answer), holder: await holder(w, task) }).toStrictEqual({
        parkedLive: true,
        code: 'not-a-refusal',
        holder: { agent, person: null },
      });
    }, 30_000);
  },
);
