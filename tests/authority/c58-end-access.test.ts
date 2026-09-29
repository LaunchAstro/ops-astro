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

import { randomUUID } from 'node:crypto';
import { sign } from 'hono/jwt';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { createGoTrueLogins } from '../../apps/api/auth/logins.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import {
  settleAccessEndings,
  type LoginProvider,
  type ProviderAnswer,
} from '../../packages/core-commands/src/index.ts';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { SESSION_ABSOLUTE_SECONDS } from '../../packages/core-records/src/index.ts';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/surface.ts';
import { ACCEPTANCE_ISSUER, ACCEPTANCE_SECRET, tokenFor } from '../acceptance/cast.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import {
  agentPath,
  bearer,
  call,
  personPath,
  serverUrl,
  type Answer,
} from '../acceptance/world.ts';
import {
  enrol,
  grantTo,
  shareWithClient,
  WHOLE_BUSINESS,
  type Member,
} from '../commands/fixture.ts';

const CANARY = 'CANARY-c58-end-access-4be91c';

if (serverUrl === undefined) {
  console.warn('authority/c58-end-access: DATABASE_URL is unset, so nothing below ran.');
}

type Step = 'endSessions' | 'deactivate';
type Scripted = ProviderAnswer<void> | 'throw';

/** A provider that answers from a script, step by step, and records every call. */
function scripted(script: Partial<Record<Step, Scripted[]>> = {}) {
  const calls: { readonly step: Step; readonly subject: string }[] = [];
  const answer = (step: Step, subject: string): Promise<ProviderAnswer<void>> => {
    calls.push({ step, subject });
    const next = script[step]?.shift();
    if (next === 'throw') return Promise.reject(new Error(`the provider fell over: ${CANARY}`));
    return Promise.resolve(next ?? { ok: true, value: undefined });
  };
  const provider: LoginProvider = {
    endSessions: async (subject) => await answer('endSessions', subject),
    deactivate: async (subject) => await answer('deactivate', subject),
  };
  return { calls, provider };
}

const FAIL: ProviderAnswer<void> = { ok: false, fault: 'unreachable' };

const outcome = (answer: Answer) => ({ status: answer.status, code: answer.code });

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A GoTrue-shaped bearer whose first sign-in was `signedInAt`. */
async function signedIn(subject: string, signedInAt: number | null, iat = nowSeconds()) {
  return await sign(
    {
      sub: subject,
      aud: 'authenticated',
      iss: ACCEPTANCE_ISSUER,
      role: 'authenticated',
      iat,
      exp: iat + 3600,
      ...(signedInAt === null ? {} : { amr: [{ method: 'password', timestamp: signedInAt }] }),
    },
    ACCEPTANCE_SECRET,
    'HS256',
  );
}

/** A read the person could make yesterday: their own capabilities. */
const ownCall = async (api: ReturnType<typeof createApi>, token: string, key = 'alpha') =>
  await call(api, personPath(key, '/session/capabilities'), {}, bearer(token));

describe.skipIf(serverUrl === undefined)("C58 end a person's access in one act", () => {
  let harness: Harness;
  let clientToken: string;
  let credential: string;

  const apiWith = (logins?: LoginProvider, now?: () => number) =>
    createApi({
      database: harness.world.db.app,
      verify: createSupabaseVerifier({
        secret: ACCEPTANCE_SECRET,
        issuer: ACCEPTANCE_ISSUER,
        ...(now === undefined ? {} : { now }),
      }),
      resolveBusiness: (key: string) =>
        Promise.resolve({ alpha: harness.world.alpha, bravo: harness.world.bravo }[key]),
      executeCommand,
      executeRead,
      executeAgentCommand,
      ...(logins === undefined ? {} : { logins }),
    });

  const end = async (
    api: ReturnType<typeof apiWith>,
    holderId: unknown,
    token?: string,
    key = 'alpha',
  ) =>
    await call(
      api,
      personPath(key, '/access/end'),
      { operationId: randomUUID(), holderId },
      bearer(token ?? harness.world.ada.token),
    );

  /** A teammate of `businessId` with a task grant, one over a client, and a delegation. */
  const teammate = async (name: string, businessId = harness.world.alpha) => {
    const person = await enrol(
      harness.world.db.app,
      businessId,
      `${name}-${randomUUID().slice(0, 6)}`,
    );
    await harness.world.db.app.withBusiness(businessId, async (tx) => {
      await grantTo(tx, person, 'write', WHOLE_BUSINESS);
      await grantTo(tx, person, 'read', WHOLE_BUSINESS);
    });
    return { person, token: await signedIn(person.presented.subject, nowSeconds() - 60) };
  };

  /** The rows `access.end` touches for one person, to show what changed. */
  const stateOf = async (person: Member, businessId = harness.world.alpha) =>
    await harness.world.db.app.withBusiness(businessId, async (tx) => {
      const one = async (sql: string) =>
        (await tx.query<{ readonly n: number }>(sql, [person.personId]))[0]?.n ?? -1;
      return {
        liveGrants: await one(
          `select count(*)::int as n from public.grants
            where subject_kind = 'person' and subject_id = $1 and revoked_at is null`,
        ),
        liveDelegations: await one(
          `select count(*)::int as n from public.delegations
            where delegate_person_id = $1 and revoked_at is null and settled_at is null`,
        ),
        activeMemberships: await one(
          `select count(*)::int as n from public.memberships where person_id = $1 and active`,
        ),
        activeActors: await one(
          `select count(*)::int as n from public.actors where person_id = $1 and active`,
        ),
        endings: await tx.query<{
          readonly sessions: boolean;
          readonly login: boolean;
          readonly attempts: number;
          readonly fault: string | null;
          readonly by: string;
        }>(
          `select sessions_ended_at is not null as sessions,
                  login_deactivated_at is not null as login,
                  attempts, last_fault as fault, ended_by_actor_id::text as by
             from public.access_endings where person_id = $1`,
          [person.personId],
        ),
      };
    });

  beforeAll(async () => {
    harness = await createHarness('c58_access_end');
    const { world } = harness;
    await world.db.app.withBusiness(world.bravo, async (tx) => {
      await grantTo(tx, world.bea as unknown as Member, 'manage', WHOLE_BUSINESS, false, 'access');
    });
    const client = await shareWithClient(
      world.db.app,
      world.alpha,
      world.ada as unknown as Member,
      harness.alphaTask.id,
    );
    clientToken = await tokenFor(client.presented.subject);
    const { decided } = await harness.approvedReservation();
    expect(decided.code, 'the decision a pickup needs').toBe('ok');
    const reservationId = (decided.body['detail'] as Record<string, unknown>)['reservationId'];
    const picked = await harness.asAgent('task.pickup', { reservationId });
    expect(picked.code, 'the pickup').toBe('ok');
    credential = String((picked.body['detail'] as Record<string, unknown>)['credential']);
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

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
    await again();
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

    // The last business-wide access:manage of a person who can sign in is
    // never ended; the refusal writes nothing.
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
        adminToken: () => Promise.resolve('admin-bearer'),
        subjectToken: () => Promise.resolve('subject-bearer'),
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
    // A subject that is not the provider's id shape is never sent.
    const never = createGoTrueLogins({
      baseUrl: 'http://127.0.0.1:9',
      adminToken: () => Promise.resolve('a'),
      subjectToken: () => Promise.resolve('s'),
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

  it("C58 refresh revoked: the provider steps are the global sign-out (every refresh token) and the login's deactivation, each shaped", async () => {
    const subject = randomUUID();
    const sent: { url: string; method: string; auth: string | null; body: string | null }[] = [];
    const logins = createGoTrueLogins({
      baseUrl: 'http://127.0.0.1:9/auth/v1',
      adminToken: () => Promise.resolve('admin-bearer'),
      subjectToken: (who) => Promise.resolve(`subject-bearer-for-${who}`),
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        sent.push({
          url: String(input),
          method: String(init?.method),
          auth: headers.get('authorization'),
          body: typeof init?.body === 'string' ? init.body : null,
        });
        return Promise.resolve(
          String(input).includes('/logout')
            ? new Response(null, { status: 204 })
            : Response.json({ id: subject, banned_until: '2999-01-01T00:00:00Z' }),
        );
      },
    });
    expect(await logins.endSessions(subject)).toEqual({ ok: true, value: undefined });
    expect(await logins.deactivate(subject)).toEqual({ ok: true, value: undefined });
    expect(sent).toEqual([
      {
        url: 'http://127.0.0.1:9/auth/v1/logout?scope=global',
        method: 'POST',
        auth: `Bearer subject-bearer-for-${subject}`,
        body: null,
      },
      {
        url: `http://127.0.0.1:9/auth/v1/admin/users/${subject}`,
        method: 'PUT',
        auth: 'Bearer admin-bearer',
        body: JSON.stringify({ ban_duration: '876000h' }),
      },
    ]);
  });

  it('C58 session boundaries: 12 hours from the first sign-in, one second either side, no idle limit, and no first-sign-in time is no session', async () => {
    const { person } = await teammate('ari');
    let clock = nowSeconds();
    const api = apiWith(undefined, () => clock);
    const at = async (signedInAt: number | null) =>
      outcome(await ownCall(api, await signedIn(person.presented.subject, signedInAt, clock - 60)));

    expect(SESSION_ABSOLUTE_SECONDS).toBe(12 * 60 * 60);
    expect(await at(clock - SESSION_ABSOLUTE_SECONDS + 1)).toEqual({ status: 200, code: 'ok' });
    expect(await at(clock - SESSION_ABSOLUTE_SECONDS - 1)).toEqual({
      status: 401,
      code: 'AUTH_SESSION_EXPIRED',
    });
    expect(await at(null)).toEqual({ status: 401, code: 'AUTH_SESSION_EXPIRED' });

    // Idle for hours inside the 12: signed in at t, a call at t+1h, nothing
    // for six hours, then a refreshed token at t+7h is still a session.
    const start = clock;
    clock = start + 3600;
    expect(await at(start)).toEqual({ status: 200, code: 'ok' });
    clock = start + 7 * 3600;
    expect(await at(start)).toEqual({ status: 200, code: 'ok' });
    // A refresh moves `iat`, never the first sign-in: at t+12h+1s it has ended.
    clock = start + SESSION_ABSOLUTE_SECONDS + 1;
    expect(await at(start)).toEqual({ status: 401, code: 'AUTH_SESSION_EXPIRED' });
  });

  it("C58 isolation: another business, another client and a delegated agent never end, read or retry another's person", async () => {
    const { provider, calls } = scripted({ endSessions: [FAIL], deactivate: [FAIL] });
    const api = apiWith(provider);
    const alphaMate = await teammate('bo');
    const bravoMate = await teammate('cy', harness.world.bravo);
    const alphaBefore = await stateOf(alphaMate.person);

    // Another business: Bea on bravo naming alpha's person gets the answer a
    // made-up id gets; Bea on alpha's prefix is no member of alpha; Ada naming
    // bravo's person is NOT_FOUND.
    const beaAcross = await end(api, alphaMate.person.personId, harness.world.bea.token, 'bravo');
    const beaMadeUp = await end(api, randomUUID(), harness.world.bea.token, 'bravo');
    expect(outcome(beaAcross)).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(beaAcross.body).toEqual(beaMadeUp.body);
    expect(outcome(await end(api, alphaMate.person.personId, harness.world.bea.token))).toEqual({
      status: 403,
      code: 'AUTH_NO_MEMBERSHIP',
    });
    expect(outcome(await end(api, bravoMate.person.personId))).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    });

    // Another client in the same business: a person holding only one client's
    // grants holds no access:manage over the business, so ends nobody.
    const party = await enrol(
      harness.world.db.app,
      harness.world.alpha,
      `dee-${randomUUID().slice(0, 6)}`,
    );
    await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
      await grantTo(tx, party, 'manage', { kind: 'party', id: randomUUID() }, false, 'access');
    });
    const partyToken = await signedIn(party.presented.subject, nowSeconds() - 60);
    expect(outcome(await end(api, alphaMate.person.personId, partyToken))).toEqual({
      status: 403,
      code: 'SCOPE_NOT_GRANTED',
    });

    // Another person under a live delegation: the agent acting for Ada is
    // refused, whatever Ada holds.
    const agent = await call(
      api,
      agentPath('alpha', '/access/end'),
      { operationId: randomUUID(), holderId: alphaMate.person.personId },
      { ...bearer(harness.world.agent.token), [DELEGATION_HEADER]: credential },
    );
    expect(outcome(agent)).toEqual({ status: 403, code: 'DELEGATION_EXCLUDES_OPERATION' });
    expect(await stateOf(alphaMate.person)).toEqual(alphaBefore);

    // Bravo's ending is bravo's: retrying alpha's never touches it.
    expect(
      outcome(await end(api, bravoMate.person.personId, harness.world.bea.token, 'bravo')),
    ).toEqual({ status: 200, code: 'ok' });
    const bravoOwed = await stateOf(bravoMate.person, harness.world.bravo);
    calls.length = 0;
    await settleAccessEndings(harness.world.db.app, harness.world.alpha, provider, {
      claimSeconds: 0,
    });
    expect(calls.map((each) => each.subject)).not.toContain(bravoMate.person.presented.subject);
    expect(await stateOf(bravoMate.person, harness.world.bravo)).toEqual(bravoOwed);
    expect(await stateOf(bravoMate.person)).toMatchObject({ endings: [] });
  });

  it("C58 canary: a planted secret in the input or the provider's answer reaches no log, audit row, operation row, ending or refusal", async () => {
    const logged: string[] = [];
    const capture = (...parts: unknown[]) => void logged.push(parts.map(String).join(' '));
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(capture),
    );
    const { person } = await teammate(`eve-${CANARY}`);
    try {
      const api = apiWith(scripted({ endSessions: ['throw'] }).provider);
      const answers = [
        await end(api, CANARY),
        await end(api, `${randomUUID()}${CANARY}`),
        await end(api, person.personId, harness.world.noah.token),
        await end(api, person.personId),
      ];
      for (const answer of answers.slice(0, 3)) {
        expect(answer.status).toBeGreaterThanOrEqual(400);
      }
      expect(answers[3]?.code).toBe('ok');
      for (const answer of answers) expect(JSON.stringify(answer.body)).not.toContain(CANARY);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(logged.join('\n')).not.toContain(CANARY);
    const stored = await harness.world.db.app.withBusiness(
      harness.world.alpha,
      async (tx) =>
        await tx.query<{ readonly row: string }>(
          `select to_jsonb(e)::text as row from public.audit_events e where command = 'access.end'
           union all select to_jsonb(o)::text from public.operations o
           union all select to_jsonb(a)::text from public.access_endings a`,
        ),
    );
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.map((each) => each.row).join('\n')).not.toContain(CANARY);
  });
});
