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

import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createGoTrueLogins } from '../../apps/api/auth/logins.ts';
import { settleAccessEndings } from '../../packages/core-commands/src/index.ts';
import { SESSION_ABSOLUTE_SECONDS } from '../../packages/core-records/src/index.ts';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/surface.ts';
import { agentPath, bearer, call, serverUrl } from '../acceptance/world.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import {
  CANARY,
  scripted,
  FAIL,
  outcome,
  nowSeconds,
  signedIn,
  ownCall,
  harness,
  credential,
  apiWith,
  end,
  teammate,
  stateOf,
  useEndAccessWorld,
} from './c58-end-access-world.ts';

// WORLD-IMPORTS c58-end-access-world.ts

useEndAccessWorld();

async function c58IsolationAnotherBusinessAnotherClientAnd(): Promise<void> {
  const { provider } = scripted({ endSessions: [FAIL], deactivate: [FAIL] });
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
}

async function c58SessionBoundaries12HoursFromThe(): Promise<void> {
  const { person } = await teammate('ari');
  let clock = nowSeconds();
  const api = apiWith(undefined, () => clock);
  // Each call carries a freshly refreshed token (its `iat` is the real
  // clock's, as the verifier's signature check reads it); the server's clock
  // is the one the limit is measured on, moved below.
  const at = async (signedInAt: number | null) =>
    outcome(
      await ownCall(api, await signedIn(person.presented.subject, signedInAt, nowSeconds() - 60)),
    );

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
}

async function c58IsolationBravoSEndingIsBravo(): Promise<void> {
  const { provider, calls } = scripted({ endSessions: [FAIL], deactivate: [FAIL] });
  const api = apiWith(provider);
  const bravoMate = await teammate('cy', harness.world.bravo);
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
}

async function c58CanaryAPlantedSecretInThe(): Promise<void> {
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
}

async function c58RefreshRevokedTheProviderStepsAre(): Promise<void> {
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
}

describe.skipIf(serverUrl === undefined)("C58 end a person's access in one act", () => {
  it(
    'C58 session boundaries: 12 hours from the first sign-in, one second either side, no idle limit, and no first-sign-in time is no session',
    c58SessionBoundaries12HoursFromThe,
  );
  it(
    "C58 isolation: another business, another client and a delegated agent never end, read or retry another's person",
    c58IsolationAnotherBusinessAnotherClientAnd,
  );
  it(
    "C58 isolation: bravo's ending is bravo's, and retrying alpha's never calls for or changes it",
    c58IsolationBravoSEndingIsBravo,
  );
  it(
    "C58 canary: a planted secret in the input or the provider's answer reaches no log, audit row, operation row, ending or refusal",
    c58CanaryAPlantedSecretInThe,
  );
  it(
    "C58 refresh revoked: the provider steps are the global sign-out (every refresh token) and the login's deactivation, each shaped",
    c58RefreshRevokedTheProviderStepsAre,
  );
});
