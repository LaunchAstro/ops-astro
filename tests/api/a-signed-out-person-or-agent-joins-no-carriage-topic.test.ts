// SPDX-License-Identifier: AGPL-3.0-only
//
// A token whose session this product has ended joins no carriage topic: the
// owner on its call's topic and the agent on its own doorbell are admitted
// while signed in, and once the session is ended both the product's own
// resolvers and the join function refuse the same token.

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
import { endProviderSession } from '../../packages/core-records/src/identity/sessions.ts';

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
  },
);
