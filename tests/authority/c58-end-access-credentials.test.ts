// SPDX-License-Identifier: AGPL-3.0-only
//
// C58 and the agent credentials an ended person issued (API-2). Ending a
// person's access revokes every live credential they issued in that business,
// in the same act, and deactivates each one's agent actor, so nothing they
// issued stays usable for its 90 days. Another person's credential in the same
// business, and the same provider user's credential in another business, are
// left as they were. An issue racing the ending takes the same access lock,
// so it is refused or revoked with the rest. Every name below is made up.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { bearer, call, personPath, serverUrl, type Answer } from '../acceptance/world.ts';
import { grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import {
  apiWith,
  end,
  harness,
  nowSeconds,
  outcome,
  scripted,
  signedIn,
  teammate,
  useEndAccessWorld,
} from './c58-end-access-world.ts';

useEndAccessWorld();

const DAY_MS = 24 * 60 * 60 * 1000;

const issue = async (
  api: ReturnType<typeof apiWith>,
  token: string,
  key = 'alpha',
): Promise<string> => {
  const answer: Answer = await call(
    api,
    personPath(key, '/credential/issue'),
    {
      operationId: randomUUID(),
      scope: [{ collection: 'task', action: 'read' }],
      expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
      purpose: 'the command line on a laptop',
    },
    bearer(token),
  );
  expect(outcome(answer), 'the issue').toEqual({ status: 200, code: 'ok' });
  return String((answer.body['detail'] as Record<string, unknown>)['credentialId']);
};

/** Each credential's revoker (null while live) and whether its agent actor is active. */
const credentialsOf = async (
  businessId: string,
  ids: readonly string[],
): Promise<readonly { readonly revokedBy: string | null; readonly agentActive: boolean }[]> =>
  await harness.world.db.app.withBusiness(
    businessId,
    async (tx) =>
      await tx.query<{ readonly revokedBy: string | null; readonly agentActive: boolean }>(
        `select c.revoked_by_actor_id::text as "revokedBy", a.active as "agentActive"
           from unnest($1::uuid[]) with ordinality as named(id, n)
           join public.agent_credentials c on c.id = named.id
           join public.actors a on a.business_id = c.business_id and a.id = c.agent_actor_id
          order by named.n`,
        [ids],
      ),
  );

const keyed = async (businessId: string, member: Member): Promise<void> => {
  await harness.world.db.app.withBusiness(businessId, async (tx) => {
    await grantTo(tx, member, 'read', WHOLE_BUSINESS);
    await grantTo(tx, member, 'write', WHOLE_BUSINESS, false, 'credential');
  });
};

describe.skipIf(serverUrl === undefined)('C58 ending access and agent credentials', () => {
  it('access.end revokes every live credential the person issued', async () => {
    const api = apiWith(scripted().provider);
    const { world } = harness;
    const { person, token } = await teammate('ivo');
    await keyed(world.alpha, person);
    // The same provider user, live in bravo too and holding the key there.
    const inBravo = await world.db.app.withBusiness(world.bravo, async (tx) => {
      const personId = await insertPerson(tx, 'ivo-in-bravo');
      const actorId = await insertActor(tx, personId);
      await insertMembership(tx, personId);
      await insertMapping(tx, await insertLogin(tx, person.presented.subject), personId, actorId);
      return { personId, actorId, presented: person.presented } satisfies Member;
    });
    await keyed(world.bravo, inBravo);
    const bravoToken = await signedIn(person.presented.subject, nowSeconds() - 60);

    const own = [await issue(api, token), await issue(api, token)];
    const adaOwn = await issue(api, world.ada.token);
    const bravoOwn = await issue(api, bravoToken, 'bravo');

    const ended = await end(api, person.personId);
    expect(outcome(ended)).toEqual({ status: 200, code: 'ok' });

    // Revoked by the manager who ended the access, each agent actor with it.
    const revoked = { revokedBy: world.ada.actorId, agentActive: false };
    expect(await credentialsOf(world.alpha, own)).toEqual([revoked, revoked]);
    // Another person's in the same business, and the same user's in bravo, untouched.
    const live = { revokedBy: null, agentActive: true };
    expect(await credentialsOf(world.alpha, [adaOwn])).toEqual([live]);
    expect(await credentialsOf(world.bravo, [bravoOwn])).toEqual([live]);
    expect((ended.body['detail'] as Record<string, unknown>)['credentialsRevoked']).toBe(2);
  });
});

/** A promise and the call that settles it. */
function latch(): { readonly promise: Promise<void>; readonly open: () => void } {
  const settle: (() => void)[] = [];
  const promise = new Promise<void>((resolve) => {
    settle.push(resolve);
  });
  return { promise, open: () => settle[0]?.() };
}

const codeOf = (result: Awaited<ReturnType<typeof executeCommand>>): string =>
  isCommandRefusal(result) ? result.code : 'ok';

/** The live credentials the person issued in alpha. */
const liveIssuedBy = async (personId: string): Promise<readonly { readonly id: string }[]> =>
  await harness.world.db.app.withBusiness(
    harness.world.alpha,
    async (tx) =>
      await tx.query<{ readonly id: string }>(
        `select id from public.agent_credentials
          where issued_by_person_id = $1::uuid and revoked_at is null`,
        [personId],
      ),
  );

/** Until `act` settles or some transaction waits on a lock, whichever is first. */
async function settledOrWaiting(act: Promise<unknown>): Promise<void> {
  const state = { settled: false };
  void act.finally(() => {
    state.settled = true;
  });
  for (let tries = 0; tries < 1500 && !state.settled; tries += 1) {
    // eslint-disable-next-line no-await-in-loop -- polled until one of the two holds
    const [row] = await harness.world.db.admin.execute<{ readonly waiting: boolean }>(
      'select exists (select 1 from pg_locks where not granted) as waiting',
    );
    if (row?.waiting === true) return;
    // eslint-disable-next-line no-await-in-loop -- the poll's pause
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

/** A connection whose transactions stop before the issue's first write until `go` opens. */
function pausedBeforeIssueWrites(url: string): {
  readonly database: Database;
  readonly reached: ReturnType<typeof latch>;
  readonly go: ReturnType<typeof latch>;
} {
  const inner = connect(url, { source: 'runtime', max: 1 });
  const reached = latch();
  const go = latch();
  const database: Database = {
    log: inner.log,
    close: async () => await inner.close(),
    withBusiness: async (businessId, run) =>
      await inner.withBusiness(
        businessId,
        async (tx) =>
          await run({
            businessId: tx.businessId,
            savepoint: tx.savepoint,
            query: async (text, parameters) => {
              if (/^\s*insert into public\.actors\b/u.test(text)) {
                reached.open();
                await go.promise;
              }
              return await tx.query(text, parameters);
            },
          }),
      ),
  };
  return { database, reached, go };
}

describe.skipIf(serverUrl === undefined)('C58 ending access and agent credentials', () => {
  it('an issue that checked its grants before access.end committed leaves no live credential', async () => {
    const { world } = harness;
    const { person } = await teammate('una');
    await keyed(world.alpha, person);
    const paused = pausedBeforeIssueWrites(world.db.appUrl);
    const wide = connect(world.db.appUrl, { source: 'runtime', max: 1 });
    try {
      // The issue checks the person's grants, then stops before it writes.
      const issued = executeCommand(paused.database, world.alpha, person.presented, 'api', {
        operationId: randomUUID(),
        command: 'credential.issue',
        scope: [{ collection: 'task', action: 'read' }],
        expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
        purpose: 'the command line on a laptop',
      } as Parameters<typeof executeCommand>[4]);
      await paused.reached.promise;
      // The ending runs meanwhile on another connection, and commits unless it waits.
      const ended = executeCommand(wide, world.alpha, world.ada.presented, 'api', {
        operationId: randomUUID(),
        command: 'access.end',
        holderId: person.personId,
      } as Parameters<typeof executeCommand>[4]);
      await settledOrWaiting(ended);
      paused.go.open();
      expect(codeOf(await ended)).toBe('ok');
      expect(['ok', 'CREDENTIAL_SCOPE_WIDENS', 'AUTH_NO_MEMBERSHIP']).toContain(
        codeOf(await issued),
      );
      const live = await liveIssuedBy(person.personId);
      expect(live, 'a credential the ended person issued, still live').toEqual([]);
    } finally {
      paused.go.open();
      await paused.database.close();
      await wide.close();
    }
  });
});
