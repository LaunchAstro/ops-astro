// SPDX-License-Identifier: AGPL-3.0-only
//
// Deactivating an agent closes every conversation membership it has open, in
// the same transaction; storage refuses an open membership for an agent that
// is not active; and a call carried by it afterwards does not admit it to the
// call's topic or its doorbell. Control: the active agent is admitted.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import {
  callTopic,
  carriageBusiness,
  carriedCall,
  conversationOf,
  doorbellTopic,
  mayJoin,
  openMembership,
  type CarriageBusiness,
} from './carriage-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one business, before and after the deactivation
describe.skipIf(serverUrl === undefined)('a deactivated agent', () => {
  let db: FreshDatabase;
  let alpha: CarriageBusiness;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'agent_deactivated' });
    alpha = await carriageBusiness(db.app, 'alpha');
  }, 120_000);

  afterAll(async () => await db?.drop());

  const openFor = async (agent: string) =>
    await db.admin.execute<{ readonly conversation_id: string }>(
      `select conversation_id::text from public.conversation_agent_members
        where agent_actor_id = $1 and left_at is null order by conversation_id`,
      [agent],
    );

  it('is closed out of every conversation and admitted to nothing after', async () => {
    const second = await db.app.withBusiness(
      alpha.id,
      async (tx) => await carriedCall(tx, alpha.owner, alpha.agent),
    );
    const sub = { sub: alpha.agent.sub };
    // Control: active, a member of two conversations, admitted to its call and doorbell.
    expect(await openFor(alpha.agent.actor)).toHaveLength(2);
    expect(await mayJoin(db.admin, callTopic(alpha.id, alpha.callId), sub)).toBe(true);
    expect(await mayJoin(db.admin, doorbellTopic(alpha.id, alpha.agent.actor), sub)).toBe(true);
    // The other agent's membership is not this agent's to lose.
    await db.app.withBusiness(alpha.id, async (tx) => {
      await openMembership(tx, second.conversationId, alpha.otherAgent, alpha.owner);
    });

    await db.app.withBusiness(alpha.id, async (tx) => {
      await tx.query(
        `update actors set active = false, deactivated_at = now() where business_id = $1 and id = $2`,
        [alpha.id, alpha.agent.actor],
      );
    });

    expect(await openFor(alpha.agent.actor)).toHaveLength(0);
    expect(await openFor(alpha.otherAgent.actor)).toEqual([
      { conversation_id: second.conversationId },
    ]);
    // A call given to it afterwards admits it nowhere.
    const later = await db.app.withBusiness(
      alpha.id,
      async (tx) => await carriedCall(tx, alpha.owner, alpha.agent, false),
    );
    expect(await mayJoin(db.admin, callTopic(alpha.id, later.callId), sub)).toBe(false);
    expect(await mayJoin(db.admin, callTopic(alpha.id, alpha.callId), sub)).toBe(false);
    expect(await mayJoin(db.admin, doorbellTopic(alpha.id, alpha.agent.actor), sub)).toBe(false);
  });

  it('storage refuses it an open membership', async () => {
    await expect(
      db.app.withBusiness(alpha.id, async (tx) => {
        const { conversationId } = await conversationOf(tx, alpha.owner);
        await openMembership(tx, conversationId, alpha.agent, alpha.owner);
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
