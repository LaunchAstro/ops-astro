// SPDX-License-Identifier: AGPL-3.0-only
//
// The carriage join judgement (`ops_carry_may_join`) on the ids a topic names
// and the business it names. A topic is refused in any capitals, whoever
// asks; another business's ids in a topic are refused, whoever asks; one
// provider user with logins in two businesses is admitted in each only to that
// business's own topics, and an ending of their access in one leaves the other.
// Against a writer at the same moment: the judgement is one read of committed
// rows, so an access ending or a membership close uncommitted still admits,
// and committed refuses, with no write of its own in between.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { hold } from '../support/lock-wait-race.ts';
import {
  callTopic,
  carriageBusiness,
  doorbellTopic,
  mayJoin,
  type CarriageBusiness,
} from './carriage-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const as = (sub: string) => ({ sub, role: 'authenticated' });

// eslint-disable-next-line max-lines-per-function -- one database, three businesses
describe.skipIf(serverUrl === undefined)('the carry join judgement on case and business', () => {
  let db: FreshDatabase;
  let alpha: CarriageBusiness;
  let beta: CarriageBusiness;
  /** Beta's owner and agent sign in as alpha's owner and agent: one provider user each, two logins. */
  let gamma: CarriageBusiness;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'carry_join_scope' });
    alpha = await carriageBusiness(db.app, 'alpha');
    beta = await carriageBusiness(db.app, 'beta');
    gamma = await carriageBusiness(db.app, 'gamma', {
      owner: alpha.owner.sub,
      agent: alpha.agent.sub,
    });
  }, 120_000);

  afterAll(async () => await db?.drop());

  it('control: the owner and the member agent are admitted to their own topics', async () => {
    expect(await mayJoin(db.admin, callTopic(alpha.id, alpha.callId), as(alpha.owner.sub))).toBe(
      true,
    );
    expect(await mayJoin(db.admin, callTopic(alpha.id, alpha.callId), as(alpha.agent.sub))).toBe(
      true,
    );
    expect(
      await mayJoin(db.admin, doorbellTopic(alpha.id, alpha.agent.actor), as(alpha.agent.sub)),
    ).toBe(true);
  });

  it.each([
    ['the business', (b: CarriageBusiness) => callTopic(b.id.toUpperCase(), b.callId)],
    ['the call', (b: CarriageBusiness) => callTopic(b.id, b.callId.toUpperCase())],
    ['the whole topic', (b: CarriageBusiness) => callTopic(b.id, b.callId).toUpperCase()],
  ])(
    'upper case: a call topic naming %s in capitals is refused to its own owner and agent',
    async (_name, topic) => {
      expect(await mayJoin(db.admin, topic(alpha), as(alpha.owner.sub))).toBe(false);
      expect(await mayJoin(db.admin, topic(alpha), as(alpha.agent.sub))).toBe(false);
    },
  );

  it('upper case: a doorbell naming the agent in capitals, or a subject in capitals, is refused', async () => {
    expect(
      await mayJoin(
        db.admin,
        doorbellTopic(alpha.id, alpha.agent.actor.toUpperCase()),
        as(alpha.agent.sub),
      ),
    ).toBe(false);
    expect(
      await mayJoin(
        db.admin,
        doorbellTopic(alpha.id, alpha.agent.actor),
        as(alpha.agent.sub.toUpperCase()),
      ),
    ).toBe(false);
  });

  it("scope: another business's ids in a topic are refused, whoever asks", async () => {
    // Alpha's call under beta's business, asked by beta's owner and by alpha's.
    for (const sub of [beta.owner.sub, alpha.owner.sub, beta.agent.sub, alpha.agent.sub]) {
      // oxlint-disable-next-line no-await-in-loop -- one subject at a time
      expect(await mayJoin(db.admin, callTopic(beta.id, alpha.callId), as(sub))).toBe(false);
      // oxlint-disable-next-line no-await-in-loop -- one subject at a time
      expect(await mayJoin(db.admin, doorbellTopic(beta.id, alpha.agent.actor), as(sub))).toBe(
        false,
      );
    }
    // Beta's call under alpha's business, asked by alpha's owner and agent.
    expect(await mayJoin(db.admin, callTopic(alpha.id, beta.callId), as(alpha.owner.sub))).toBe(
      false,
    );
    expect(await mayJoin(db.admin, callTopic(alpha.id, beta.callId), as(alpha.agent.sub))).toBe(
      false,
    );
  });

  it("two businesses' logins: each admits only its own business's topics", async () => {
    const owner = as(alpha.owner.sub);
    const agent = as(alpha.agent.sub);
    expect(await mayJoin(db.admin, callTopic(gamma.id, gamma.callId), owner)).toBe(true);
    expect(await mayJoin(db.admin, callTopic(gamma.id, gamma.callId), agent)).toBe(true);
    expect(await mayJoin(db.admin, doorbellTopic(gamma.id, gamma.agent.actor), agent)).toBe(true);
    // Crossed: one business's id under the other's.
    expect(await mayJoin(db.admin, callTopic(gamma.id, alpha.callId), owner)).toBe(false);
    expect(await mayJoin(db.admin, callTopic(alpha.id, gamma.callId), owner)).toBe(false);
    expect(await mayJoin(db.admin, doorbellTopic(gamma.id, alpha.agent.actor), agent)).toBe(false);
    expect(await mayJoin(db.admin, doorbellTopic(alpha.id, gamma.agent.actor), agent)).toBe(false);
  });

  /** The access ending of `party`'s login in `business`, as the ending writes it. */
  const ENDING = `insert into public.access_endings (business_id, person_id, login_id, ended_by_actor_id)
                  select l.business_id, pl.person_id, l.id, $3
                    from public.logins l
                    join public.person_logins pl on pl.business_id = l.business_id and pl.login_id = l.id
                   where l.business_id = $1 and l.subject = $2`;

  it('an ending in flight still admits; committed, it refuses in its business and leaves the other', async () => {
    const owner = as(alpha.owner.sub);
    const ending = await hold(db, async (execute) => {
      await execute(ENDING, [gamma.id, alpha.owner.sub, gamma.colleague.actor]);
    });
    try {
      // Uncommitted: the judgement reads what has committed, and writes nothing to wait on.
      expect(await mayJoin(db.admin, callTopic(gamma.id, gamma.callId), owner)).toBe(true);
      await ending.letGo();
      expect(await mayJoin(db.admin, callTopic(gamma.id, gamma.callId), owner)).toBe(false);
      expect(await mayJoin(db.admin, callTopic(alpha.id, alpha.callId), owner)).toBe(true);
    } finally {
      await ending.letGo();
    }
  });

  it('a membership close in flight still admits the agent; committed, it refuses', async () => {
    const agent = as(beta.agent.sub);
    const closing = await hold(db, async (execute) => {
      await execute(
        `update public.conversation_agent_members set left_at = clock_timestamp()
          where business_id = $1 and agent_actor_id = $2 and left_at is null`,
        [beta.id, beta.agent.actor],
      );
    });
    try {
      expect(await mayJoin(db.admin, callTopic(beta.id, beta.callId), agent)).toBe(true);
      await closing.letGo();
      expect(await mayJoin(db.admin, callTopic(beta.id, beta.callId), agent)).toBe(false);
      // The owner is not a member: still admitted.
      expect(await mayJoin(db.admin, callTopic(beta.id, beta.callId), as(beta.owner.sub))).toBe(
        true,
      );
    } finally {
      await closing.letGo();
    }
  });
});
