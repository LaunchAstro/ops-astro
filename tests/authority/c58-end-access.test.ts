// SPDX-License-Identifier: AGPL-3.0-only
//
// C58 (CS-2.25): end a person's access in one act, and the session contract.
//
// `access.end {holderId}` is the tracked action `access ended (person: login,
// sessions, grants)` under `access:manage`, never an agent's. In one
// transaction it ends the membership, the person's acting identity, every live
// grant and delegation, and writes one access ending per login holding the two
// provider steps still owed: end every session (which revokes the refresh
// tokens) and deactivate the login. The local state is authoritative from the
// commit, so the person's next call is refused however the provider answers;
// the provider steps are tried when the act commits and retried until each is
// done, and a step done is never asked again.
//
// Sessions have no idle limit and an absolute limit of 12 hours from the first
// sign-in (the `amr` first-factor time, never `iat`), checked at the door.
//
// Ada is alpha's owner and holds every key; Mia holds the task keys; Noah holds
// nothing; Bea is bravo's, holding `access:manage` there. Each case enrols the
// person it ends. Every name below is made up.

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createGoTrueLogins } from '../../apps/api/auth/logins.ts';
import { retryAccessEndings } from '../../apps/api/server.ts';
import { settleAccessEndings, type LoginProvider } from '../../packages/core-commands/src/index.ts';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { serverUrl } from '../acceptance/world.ts';
import type { Member } from '../commands/fixture.ts';
import {
  CANARY,
  scripted,
  FAIL,
  outcome,
  ownCall,
  harness,
  clientToken,
  apiWith,
  end,
  teammate,
  stateOf,
  useEndAccessWorld,
} from './c58-end-access-world.ts';

// WORLD-IMPORTS c58-end-access-world.ts

useEndAccessWorld();

describe.skipIf(serverUrl === undefined)("C58 end a person's access in one act", () => {
  it("C58 one act: login, sessions and grants end together, and the person's next call is refused", async () => {
    const { calls, provider } = scripted();
    const api = apiWith(provider);
    const { person, token } = await teammate('uma');
    const delegated = await harness.world.db.app.withBusiness(
      harness.world.alpha,
      async (tx) =>
        await mintDelegation(tx, {
          agentActorId: harness.world.agent.actorId as string,
          delegatePersonId: person.personId,
          mintedByActorId: person.actorId,
          purpose: 'c58_one_act',
          collections: ['task'],
          actions: ['write'],
          purposeScope: { kind: 'record', id: harness.alphaTask.id },
          expiresAt: new Date(Date.now() + 3_600_000),
        }),
    );
    expect(delegated.ok, 'a live delegation from the person').toBe(true);
    expect(outcome(await ownCall(api, token))).toEqual({ status: 200, code: 'ok' });

    const ended = await end(api, person.personId);
    expect(outcome(ended)).toEqual({ status: 200, code: 'ok' });

    expect(outcome(await ownCall(api, token))).toEqual({ status: 403, code: 'AUTH_NO_MEMBERSHIP' });
    const after = await stateOf(person);
    expect(after).toMatchObject({
      liveGrants: 0,
      liveDelegations: 0,
      activeMemberships: 0,
      activeActors: 0,
    });
    expect(after.endings).toEqual([
      { sessions: true, login: true, attempts: 1, fault: null, by: harness.world.ada.actorId },
    ]);
    // Sessions first, then the login, each once, each for this person's login.
    expect(calls).toEqual([
      { step: 'endSessions', subject: person.presented.subject },
      { step: 'deactivate', subject: person.presented.subject },
    ]);
    // Ended once: a second act finds no member to end.
    expect(outcome(await end(api, person.personId))).toEqual({ status: 404, code: 'NOT_FOUND' });
  });
});
describe.skipIf(serverUrl === undefined)("C58 end a person's access in one act", () => {
  it('C58 audit read-back: the act is its tracked action, audited against the manager, with ids and no body', async () => {
    const api = apiWith(scripted().provider);
    const { person } = await teammate('vic');
    const ended = await end(api, person.personId);
    expect(outcome(ended)).toEqual({ status: 200, code: 'ok' });
    const audited = await harness.world.db.app.withBusiness(
      harness.world.alpha,
      async (tx) =>
        await tx.query<{ readonly actor: string; readonly outcome: string; readonly row: string }>(
          `select actor_id::text as actor, outcome, to_jsonb(e)::text as row
             from public.audit_events e
            where command = 'access.end' and occurred_at > now() - interval '5 minutes'
            order by occurred_at desc limit 1`,
        ),
    );
    expect(audited[0]).toMatchObject({ actor: harness.world.ada.actorId, outcome: 'applied' });
    expect(audited[0]?.row).not.toContain(person.presented.subject);
    const detail = (ended.body['detail'] ?? {}) as Record<string, unknown>;
    expect(detail['personId']).toBe(person.personId);
    expect(detail['grantsRevoked']).toBe(2);
  });

  it('C58 access:manage refused: a task holder, a member with nothing and a client are refused, with nothing written', async () => {
    const api = apiWith(scripted().provider);
    const { person } = await teammate('wren');
    const before = await stateOf(person);
    for (const token of [harness.world.mia.token, harness.world.noah.token, clientToken]) {
      // oxlint-disable-next-line no-await-in-loop
      const refused = await end(api, person.personId, token);
      expect(refused.status).toBe(403);
      expect(['SCOPE_NOT_GRANTED', 'AUTH_NO_MEMBERSHIP']).toContain(refused.code);
    }
    expect(await stateOf(person)).toEqual(before);
  });
});
describe.skipIf(serverUrl === undefined)("C58 end a person's access in one act", () => {
  it('C58 provider retry: a failed provider deactivation is retried until it succeeds, without repeating a finished step', async () => {
    const { calls, provider } = scripted({ deactivate: [FAIL, FAIL] });
    const api = apiWith(provider);
    const { person, token } = await teammate('xan');
    expect(outcome(await end(api, person.personId))).toEqual({ status: 200, code: 'ok' });
    expect(outcome(await ownCall(api, token))).toEqual({ status: 403, code: 'AUTH_NO_MEMBERSHIP' });
    expect((await stateOf(person)).endings).toEqual([
      expect.objectContaining({ sessions: true, login: false, fault: 'unreachable' }),
    ]);

    const alpha = harness.world.alpha;
    const again = async () =>
      await settleAccessEndings(harness.world.db.app, alpha, provider, { claimSeconds: 0 });
    // The server's own pass: it finds alpha by its owed ending and settles it
    // under alpha's tenancy. The provider fails again, so the step stays owed.
    await retryAccessEndings(harness.world.db.admin, harness.world.db.app, provider, 0);
    expect((await stateOf(person)).endings[0]).toMatchObject({ login: false });
    const third = await again();
    expect(third.settled).toBeGreaterThanOrEqual(1);
    expect((await stateOf(person)).endings).toEqual([
      expect.objectContaining({ sessions: true, login: true, attempts: 3 }),
    ]);
    await again();

    const mine = calls.filter((each) => each.subject === person.presented.subject);
    expect(mine.map((each) => each.step)).toEqual([
      'endSessions',
      'deactivate',
      'deactivate',
      'deactivate',
    ]);
    expect(outcome(await ownCall(api, token))).toEqual({ status: 403, code: 'AUTH_NO_MEMBERSHIP' });
  });
});
describe.skipIf(serverUrl === undefined)("C58 end a person's access in one act", () => {
  it("C58 partial failure: a failure after each step leaves the person's next call refused, and a refused act changes nothing", async () => {
    const cases: readonly {
      readonly name: string;
      readonly logins?: LoginProvider;
      readonly owed: object;
    }[] = [
      // The process stops after the local commit: no provider step ran.
      { name: 'no provider step', owed: { sessions: false, login: false } },
      // The provider falls over on the sessions; neither step is done.
      {
        name: 'sessions throw',
        logins: scripted({ endSessions: ['throw'] }).provider,
        owed: { sessions: false, login: false },
      },
      // The sessions end; the login step fails.
      {
        name: 'login fails',
        logins: scripted({ deactivate: [FAIL] }).provider,
        owed: { sessions: true, login: false },
      },
    ];
    for (const each of cases) {
      const api = apiWith(each.logins);
      // oxlint-disable-next-line no-await-in-loop
      const { person, token } = await teammate(`yan-${each.name.replaceAll(' ', '-')}`);
      // oxlint-disable-next-line no-await-in-loop
      expect(outcome(await end(api, person.personId)), each.name).toEqual({
        status: 200,
        code: 'ok',
      });
      // oxlint-disable-next-line no-await-in-loop
      expect(outcome(await ownCall(api, token)), each.name).toEqual({
        status: 403,
        code: 'AUTH_NO_MEMBERSHIP',
      });
      // oxlint-disable-next-line no-await-in-loop
      const after = await stateOf(person);
      expect(after.endings, each.name).toEqual([expect.objectContaining(each.owed)]);
      expect(after.liveGrants, each.name).toBe(0);
    }
  });
});
describe.skipIf(serverUrl === undefined)("C58 end a person's access in one act", () => {
  it('C58 partial failure: the last business-wide access:manage is never ended, and the refusal writes nothing', async () => {
    const api = apiWith(scripted().provider);
    const bravoBefore = await stateOf(harness.world.bea as unknown as Member, harness.world.bravo);
    const last = await end(
      api,
      harness.world.bea.personId as string,
      harness.world.bea.token,
      'bravo',
    );
    expect(outcome(last)).toEqual({ status: 409, code: 'ACCESS_LAST_MANAGER' });
    expect(await stateOf(harness.world.bea as unknown as Member, harness.world.bravo)).toEqual(
      bravoBefore,
    );
  });
});
describe.skipIf(serverUrl === undefined)("C58 end a person's access in one act", () => {
  it('C58 hostile provider: a malformed, oversized, slow, redirected or wrong answer never counts as done, and the step stays owed', async () => {
    const subject = randomUUID();
    const answers: readonly (() => Response | Promise<Response>)[] = [
      () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
      () => new Response('x'.repeat(64 * 1024), { status: 200 }),
      () => new Response('not json', { status: 200 }),
      () => Response.json({ id: randomUUID(), banned_until: '2999-01-01T00:00:00Z' }),
      () => Response.json({ id: subject, banned_until: null }),
      () => Response.json({ id: subject, banned_until: '2001-01-01T00:00:00Z' }),
      () => Response.json({ message: CANARY }, { status: 500 }),
      () => Response.json({ message: CANARY }, { status: 401 }),
      () => Response.json({ surprise: CANARY }, { status: 200 }),
      async () =>
        await new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response('{}')), 400);
        }),
    ];
    const seen: { url: string; redirect: RequestInit['redirect'] }[] = [];
    for (const [index, hostile] of answers.entries()) {
      const logins = createGoTrueLogins({
        baseUrl: 'http://127.0.0.1:9/auth/v1',
        adminKey: () => Promise.resolve('admin-key'),
        timeoutMs: 200,
        maxBytes: 16 * 1024,
        fetch: (input, init) => {
          seen.push({ url: String(input), redirect: init?.redirect });
          return Promise.resolve(hostile());
        },
      });
      // oxlint-disable-next-line no-await-in-loop
      const both = [await logins.endSessions(subject), await logins.deactivate(subject)];
      expect(
        both.every((answer) => !answer.ok),
        `hostile answer ${String(index)}`,
      ).toBe(true);
      expect(JSON.stringify(both)).not.toContain(CANARY);
    }
    // One fixed destination under the configured base, no redirect followed.
    expect(seen.every((each) => each.url.startsWith('http://127.0.0.1:9/auth/v1/'))).toBe(true);
    expect(seen.every((each) => each.redirect === 'error')).toBe(true);
  });
});
describe.skipIf(serverUrl === undefined)("C58 end a person's access in one act", () => {
  it("C58 hostile provider: a subject not in the provider's id shape is never sent, and a hostile answer through the act leaves both steps owed", async () => {
    const never = createGoTrueLogins({
      baseUrl: 'http://127.0.0.1:9',
      adminKey: () => Promise.resolve('a'),
      fetch: () => Promise.reject(new Error('sent')),
    });
    expect(await never.deactivate('../admin/users')).toEqual({ ok: false, fault: 'refused' });
    expect(await never.endSessions(`x${CANARY}`)).toEqual({ ok: false, fault: 'refused' });

    // Through the act: a hostile answer leaves both steps owed and the person refused.
    const hostileLogins: LoginProvider = {
      endSessions: () => Promise.resolve({ ok: false, fault: 'malformed' }),
      deactivate: () => Promise.resolve({ ok: false, fault: 'oversized' }),
    };
    const api = apiWith(hostileLogins);
    const { person, token } = await teammate('zed');
    expect(outcome(await end(api, person.personId))).toEqual({ status: 200, code: 'ok' });
    expect(outcome(await ownCall(api, token))).toEqual({ status: 403, code: 'AUTH_NO_MEMBERSHIP' });
    expect((await stateOf(person)).endings).toEqual([
      expect.objectContaining({ sessions: false, login: false, fault: 'malformed' }),
    ]);
  });
});
