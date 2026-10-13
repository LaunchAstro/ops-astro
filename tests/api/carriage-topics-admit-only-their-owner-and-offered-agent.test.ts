// SPDX-License-Identifier: AGPL-3.0-only
//
// The carriage join judgement (`ops_carry_may_join`), asked directly with the
// claims Realtime would set. A call's topic admits its conversation's owner
// and the agent its carriers row names, while that agent is a member; an
// agent's doorbell admits that agent alone. Anyone else is refused: another
// person of the business, a person of another business, the owner of another
// call, an agent not named on the call or not a member, another agent on a
// doorbell. One provider user with a login in two businesses is admitted only
// in the business the topic names. This is the function's behaviour; whether a
// hosted project enforces its policies is the live probe's.

import { randomUUID } from 'node:crypto';
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
  doorbellTopic,
  mayJoin,
  type CarriageBusiness,
} from './carriage-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** The claims Realtime sets for a signed-in subscriber. */
const as = (sub: string) => ({ sub, role: 'authenticated' });

// eslint-disable-next-line max-lines-per-function -- one world, its admissions and refusals
describe.skipIf(serverUrl === undefined)('who a carriage topic admits', () => {
  let db: FreshDatabase;
  let alpha: CarriageBusiness;
  let bravo: CarriageBusiness;
  /** A second call in alpha, of the colleague's own conversation, carried by the same agent. */
  let colleagues: { readonly callId: string };
  /** A call in alpha whose conversation the agent is not a member of. */
  let unjoined: { readonly callId: string };

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'carriage_topics' });
    // Bravo's owner signs in as the same provider user as alpha's owner.
    alpha = await carriageBusiness(db.app, 'alpha');
    bravo = await carriageBusiness(db.app, 'bravo', { owner: alpha.owner.sub });
    [colleagues, unjoined] = await db.app.withBusiness(alpha.id, async (tx) => [
      await carriedCall(tx, alpha.colleague, alpha.agent),
      await carriedCall(tx, alpha.owner, alpha.agent, false),
    ]);
  }, 120_000);

  afterAll(async () => await db?.drop());

  it('admits the owner and the named member agent to the call, and the agent to its doorbell', async () => {
    const call = callTopic(alpha.id, alpha.callId);
    expect(await mayJoin(db.admin, call, as(alpha.owner.sub))).toBe(true);
    expect(await mayJoin(db.admin, call, as(alpha.agent.sub))).toBe(true);
    expect(
      await mayJoin(db.admin, doorbellTopic(alpha.id, alpha.agent.actor), as(alpha.agent.sub)),
    ).toBe(true);
  });

  it('refuses everyone else a call topic', async () => {
    const call = callTopic(alpha.id, alpha.callId);
    // Another person of the business, and the owner of another call.
    expect(await mayJoin(db.admin, call, as(alpha.colleague.sub))).toBe(false);
    expect(
      await mayJoin(db.admin, callTopic(alpha.id, colleagues.callId), as(alpha.owner.sub)),
    ).toBe(false);
    // An agent the call was not given to, and the given agent where it is not a member.
    expect(await mayJoin(db.admin, call, as(alpha.otherAgent.sub))).toBe(false);
    expect(await mayJoin(db.admin, callTopic(alpha.id, unjoined.callId), as(alpha.agent.sub))).toBe(
      false,
    );
    // A person of another business, and another business's agent.
    expect(await mayJoin(db.admin, call, as(bravo.colleague.sub))).toBe(false);
    expect(await mayJoin(db.admin, call, as(bravo.agent.sub))).toBe(false);
    // No claims, no subject, claims that are not JSON.
    expect(await mayJoin(db.admin, call, null)).toBe(false);
    expect(await mayJoin(db.admin, call, { role: 'authenticated' })).toBe(false);
    expect(await mayJoin(db.admin, call, 'not json')).toBe(false);
  });

  it('admits one provider user only in the business the topic names', async () => {
    // The same `sub` owns alpha's call and bravo's.
    expect(await mayJoin(db.admin, callTopic(alpha.id, alpha.callId), as(alpha.owner.sub))).toBe(
      true,
    );
    expect(await mayJoin(db.admin, callTopic(bravo.id, bravo.callId), as(alpha.owner.sub))).toBe(
      true,
    );
    // Alpha's call named under bravo's business, and bravo's under alpha's: no such call there.
    expect(await mayJoin(db.admin, callTopic(bravo.id, alpha.callId), as(alpha.owner.sub))).toBe(
      false,
    );
    expect(await mayJoin(db.admin, callTopic(alpha.id, bravo.callId), as(alpha.owner.sub))).toBe(
      false,
    );
  });

  it('refuses a doorbell to anyone but its own agent', async () => {
    const bell = doorbellTopic(alpha.id, alpha.agent.actor);
    expect(await mayJoin(db.admin, bell, as(alpha.otherAgent.sub))).toBe(false);
    expect(await mayJoin(db.admin, bell, as(alpha.owner.sub))).toBe(false);
    expect(
      await mayJoin(db.admin, doorbellTopic(bravo.id, alpha.agent.actor), as(alpha.agent.sub)),
    ).toBe(false);
  });

  it('refuses a topic that is not a canonical carriage topic', async () => {
    const owner = as(alpha.owner.sub);
    for (const topic of [
      callTopic(alpha.id, alpha.callId).toUpperCase(),
      callTopic(alpha.id.toUpperCase(), alpha.callId),
      callTopic(alpha.id, alpha.callId.toUpperCase()),
      `${callTopic(alpha.id, alpha.callId)}:x`,
      `carry:${alpha.id}:task:${alpha.callId}`,
      `live:${alpha.id}:call:${alpha.callId}`,
      callTopic(alpha.id, randomUUID()),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one judgement each, in turn
      expect(await mayJoin(db.admin, topic, owner), topic).toBe(false);
    }
  });

  it('refuses the call once it is no longer with the model, and the agent once it has left', async () => {
    const { callId, conversationId } = await db.app.withBusiness(
      alpha.id,
      async (tx) => await carriedCall(tx, alpha.owner, alpha.agent),
    );
    const call = callTopic(alpha.id, callId);
    expect(await mayJoin(db.admin, call, as(alpha.agent.sub))).toBe(true);
    await db.app.withBusiness(alpha.id, async (tx) => {
      await tx.query(
        `update conversation_agent_members set left_at = clock_timestamp()
          where business_id = $1 and conversation_id = $2 and left_at is null`,
        [alpha.id, conversationId],
      );
    });
    expect(await mayJoin(db.admin, call, as(alpha.agent.sub))).toBe(false);
    expect(await mayJoin(db.admin, call, as(alpha.owner.sub))).toBe(true);
    await db.app.withBusiness(alpha.id, async (tx) => {
      await tx.query(
        `update model_calls set state = 'released', ended_at = clock_timestamp()
          where business_id = $1 and id = $2`,
        [alpha.id, callId],
      );
    });
    expect(await mayJoin(db.admin, call, as(alpha.owner.sub))).toBe(false);
  });
});
