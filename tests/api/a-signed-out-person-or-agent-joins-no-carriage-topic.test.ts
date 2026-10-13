// SPDX-License-Identifier: AGPL-3.0-only
//
// A token whose session this product has ended joins no carriage topic: the
// owner on its call's topic and the agent on its own doorbell are admitted
// while signed in, and once the session is ended both the product's own
// resolvers and the join function refuse the same token. The join function
// reads every ending login resolution reads: a sign-out, the login's other
// sessions ended, and a reset of the login, each as of the token's first
// sign-in; a token whose first sign-in it cannot read is taken as before them.

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
  doorbellTopic,
  mayJoin,
  type CarriageBusiness,
} from './carriage-fixture.ts';
import { standingOf } from '../../packages/core-records/src/identity/login-resolution.ts';
import { resolveAgentLogin } from '../../packages/core-records/src/identity/agent-login.ts';
import {
  endOtherSeenSessions,
  endProviderSession,
  openResetWindow,
  settleResetWindow,
} from '../../packages/core-records/src/identity/sessions.ts';

/** Claims for `sub`'s session `sessionId`, first signed in at `signedInAt` (seconds), if given. */
const claimsOf = (sub: string, sessionId: string, signedInAt?: number) => ({
  sub,
  session_id: sessionId,
  role: 'authenticated',
  ...(signedInAt === undefined ? {} : { amr: [{ method: 'password', timestamp: signedInAt }] }),
});

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a signed-out session joins no carriage topic',
  () => {
    let db: FreshDatabase;
    let world: CarriageBusiness;
    beforeAll(async () => {
      db = await createFreshDatabase({ part: 'carriage_signed_out' });
      world = await carriageBusiness(db.app, 'signedout');
    }, 180_000);
    afterAll(async () => await db?.drop());

    it.each(['owner', 'agent'] as const)(
      'a signed-out %s cannot join carriage topics',
      async (kind) => {
        const subject = world[kind].sub;
        const sessionId = randomUUID();
        const presented = { provider: 'supabase', subject, sessionId };
        const claims = { sub: subject, session_id: sessionId, role: 'authenticated' };
        const topic =
          kind === 'owner'
            ? callTopic(world.id, world.callId)
            : doorbellTopic(world.id, world.agent.actor);
        const resolve = () =>
          db.app.withBusiness(world.id, async (tx) =>
            kind === 'owner'
              ? await standingOf(tx, presented, 'required')
              : await resolveAgentLogin(tx, presented),
          );
        expect(await resolve()).toHaveProperty('actorId');
        expect(await mayJoin(db.admin, topic, claims)).toBe(true);
        await db.app.withBusiness(world.id, async (tx) => await endProviderSession(tx, sessionId));
        expect(await resolve()).toMatchObject({ code: 'AUTH_SESSION_EXPIRED' });
        expect(
          await mayJoin(db.admin, topic, claims),
          'A bearer the product has signed out still passes the join policy',
        ).toBe(false);
      },
    );

    it("a session ended with the login's other sessions is refused; the kept one and a later sign-in join", async () => {
      const others = await carriageBusiness(db.app, 'endothers');
      const topic = callTopic(others.id, others.callId);
      const [kept, ended, later, unread] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      const before = nowSeconds() - 300;
      expect(await mayJoin(db.admin, topic, claimsOf(others.owner.sub, ended, before))).toBe(true);
      await db.app.withBusiness(others.id, async (tx) => {
        await endOtherSeenSessions(tx, others.owner.person, kept, 'end_others', others.owner.sub);
      });
      // The ending two minutes ago, so a sign-in now is past the minute of clock the door allows.
      await db.admin.execute(
        `update ops.ended_subject_sessions set ended_before = ended_before - interval '120 seconds'
          where subject_digest = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
        [others.owner.sub],
      );
      expect(await mayJoin(db.admin, topic, claimsOf(others.owner.sub, ended, before))).toBe(false);
      expect(await mayJoin(db.admin, topic, claimsOf(others.owner.sub, kept, before))).toBe(true);
      const after = nowSeconds();
      expect(await mayJoin(db.admin, topic, claimsOf(others.owner.sub, later, after))).toBe(true);
      expect(await mayJoin(db.admin, topic, claimsOf(others.owner.sub, unread))).toBe(false);
      // Another login's sessions are not this ending's.
      const doorbell = doorbellTopic(others.id, others.agent.actor);
      expect(await mayJoin(db.admin, doorbell, claimsOf(others.agent.sub, unread))).toBe(true);
    });

    it('a session signed in before a reset settles is refused; one signed in after it joins', async () => {
      const reset = await carriageBusiness(db.app, 'reset');
      const topic = callTopic(reset.id, reset.callId);
      const [early, late] = [randomUUID(), randomUUID()];
      const before = nowSeconds() - 100;
      expect(await mayJoin(db.admin, topic, claimsOf(reset.owner.sub, early, before))).toBe(true);
      const window = await db.app.withBusiness(
        reset.id,
        async (tx) => await openResetWindow(tx, reset.owner.sub),
      );
      expect(await mayJoin(db.admin, topic, claimsOf(reset.owner.sub, early, before))).toBe(false);
      await db.app.withBusiness(reset.id, async (tx) => await settleResetWindow(tx, window));
      expect(await mayJoin(db.admin, topic, claimsOf(reset.owner.sub, early, before))).toBe(false);
      const after = nowSeconds() + 5;
      expect(await mayJoin(db.admin, topic, claimsOf(reset.owner.sub, late, after))).toBe(true);
    });
  },
);
