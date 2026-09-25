// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 2, R2-AUTHORITY-68: a deactivated agent is refused at the
// agent door.
//
// `identity/agent-login.ts` keeps `and al.active` and `and a.active` in its
// left joins, and promises one refusal for every way resolution can fail,
// including "a mapping that was deactivated, an agent actor that was", with the
// attempt recorded before it returns. Nothing held either join. The failure
// this guards against is quiet: an administrator switches an agent off, the
// row says so, and the agent keeps signing in because one join lost a clause.
//
// The last case asks it over HTTP, of an agent already holding a lease. The
// delegation credential is still live when the actor is switched off, so the
// only thing standing between the agent and its next heartbeat is the login.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveAgentLogin } from '../../packages/core-records/src/identity/agent-login.ts';
import { readAuthenticationAttempts } from '../../packages/core-records/src/identity/authentication-attempts.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { pathOf, type CommandName } from '../../packages/core-records/src/commands/surface.ts';
import {
  insertActor,
  insertAgentActor,
  insertAgentMapping,
  insertBusiness,
  insertLogin,
  insertMembership,
  insertPerson,
} from './fixture.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from '../api/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
const PROVIDER = 'supabase';

const detailOf = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] as Record<string, unknown> | undefined) ?? {};

describe.skipIf(serverUrl === undefined)('a deactivated agent at the agent login', () => {
  let db: FreshDatabase;
  let business: string;
  let liveAgent: string;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'fr2_agent_off' });
    business = await insertBusiness(db.app, 'alpha');
    await db.app.withBusiness(business, async (tx) => {
      const adaPerson = await insertPerson(tx, 'Ada');
      const adaActor = await insertActor(tx, adaPerson);
      await insertMembership(tx, adaPerson);

      // One login per case, so each attempt row answers to one subject.
      const retiredAgent = await insertAgentActor(tx, false);
      const retiredLogin = await insertLogin(tx, 'retired-agent-subject');
      await insertAgentMapping(tx, retiredLogin, retiredAgent, adaActor, true);

      const unlinkedAgent = await insertAgentActor(tx, true);
      const unlinkedLogin = await insertLogin(tx, 'unlinked-agent-subject');
      await insertAgentMapping(tx, unlinkedLogin, unlinkedAgent, adaActor, false);

      liveAgent = await insertAgentActor(tx, true);
      const liveLogin = await insertLogin(tx, 'live-agent-subject');
      await insertAgentMapping(tx, liveLogin, liveAgent, adaActor, true);
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  const resolve = async (subject: string) =>
    await db.app.withBusiness(business, (tx) =>
      resolveAgentLogin(tx, { provider: PROVIDER, subject }),
    );

  const attempts = async (subject: string) =>
    await db.app.withBusiness(business, (tx) =>
      readAuthenticationAttempts(tx, { provider: PROVIDER, subject }),
    );

  // The one refusal, as a subject nobody holds receives it. Anything the
  // deactivated cases answer beyond this would say what exists here.
  const nobody = async () => await resolve(randomUUID());

  const expectRefusedAndRecorded = async (subject: string): Promise<void> => {
    const answer = await resolve(subject);
    expect('refused' in answer && answer.code).toBe('AUTH_NO_AGENT_IDENTITY');
    expect(answer).toStrictEqual(await nobody());

    const rows = await attempts(subject);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner: 'agent_login',
      outcome: 'refused',
      refusal_code: 'AUTH_NO_AGENT_IDENTITY',
      login_id: null,
      actor_id: null,
      person_id: null,
    });
  };

  it('refuses an agent actor that was deactivated, behind an active mapping', async () => {
    await expectRefusedAndRecorded('retired-agent-subject');
  });

  it('refuses an active agent actor whose mapping was deactivated', async () => {
    await expectRefusedAndRecorded('unlinked-agent-subject');
  });

  it('resolves the control, where the actor and the mapping are both active', async () => {
    const session = await resolve('live-agent-subject');
    expect('refused' in session).toBe(false);
    if ('refused' in session) return;
    expect(session.actorId).toBe(liveAgent);
    expect(session.kind).toBe('agent');

    const rows = await attempts('live-agent-subject');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'resolved', actor_id: liveAgent });
  });
});

describe.skipIf(serverUrl === undefined)('a deactivated agent holding a lease', () => {
  let fixture: ApiFixture;
  let asPerson: (name: CommandName, body: Record<string, unknown>) => Promise<Answer>;
  let asAgent: (
    name: CommandName,
    body: Record<string, unknown>,
    held?: string,
    token?: string,
  ) => Promise<Answer>;

  beforeAll(async () => {
    fixture = await createApiFixture('fr2_agent_off_api');
    const api = fixture.compose();
    const personToken = await tokenFor(fixture.member.presented.subject);
    const agentToken = await tokenFor(fixture.agent.subject);
    asPerson = async (name, body) =>
      await post(api, `/api/b/${BUSINESS_KEY}${pathOf(name)}`, body, authorised(personToken));
    asAgent = async (name, body, held, token = agentToken) =>
      await post(api, `/api/a/b/${BUSINESS_KEY}${pathOf(name)}`, body, {
        ...authorised(token),
        ...(held === undefined ? {} : { 'x-agent-delegation': held }),
      });
  }, 120_000);

  afterAll(async () => await fixture?.drop());

  const refusedAgentAttempts = async (): Promise<number> => {
    const rows = await fixture.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.authentication_attempts
        where business_id = $1 and owner = 'agent_login' and outcome = 'refused'
          and refusal_code = 'AUTH_NO_AGENT_IDENTITY'`,
      [fixture.business],
    );
    return Number(rows[0]?.n ?? '-1');
  };

  const leaseRow = async (leaseId: string) =>
    await fixture.db.admin.execute<Record<string, unknown>>(
      `select state, fence::text as fence, expires_at, released_at, holder_actor_id
         from public.leases where business_id = $1 and id = $2`,
      [fixture.business, leaseId],
    );

  /** A task approved and picked up, exactly as the agent prefix journey does. */
  const pickUp = async (): Promise<Answer> => {
    const created = await asPerson('task.create', {
      operationId: randomUUID(),
      fields: { title: 'the agent is switched off mid-task' },
    });
    const proposed = await asPerson('task.propose', {
      operationId: randomUUID(),
      recordId: created.body['recordId'],
      expectedRevision: created.body['revision'],
      purpose: 'final_r2_deactivation',
      maximumMinor: 2_500,
      currency: 'AUD',
      payload: { instruction: 'draft a reply to the client' },
      step: { kind: 'compose', payload: { tone: 'plain' } },
    });
    const decided = await asPerson('task.decide', {
      operationId: randomUUID(),
      gateId: detailOf(proposed)['gateId'],
      versionId: detailOf(proposed)['versionId'],
      decision: 'approve',
      note: 'approved for the deactivation proof',
    });
    return await asAgent('task.pickup', {
      operationId: randomUUID(),
      reservationId: detailOf(decided)['reservationId'],
    });
  };

  it('answers the next heartbeat AUTH_NO_AGENT_IDENTITY 401 and leaves the lease alone', async () => {
    const picked = await pickUp();
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);
    const leaseId = String(detailOf(picked)['leaseId']);
    const fence = detailOf(picked)['fence'];
    const credential = String(detailOf(picked)['credential']);

    // The control: while the agent is active, the heartbeat lands.
    const alive = await asAgent(
      'task.heartbeat',
      { operationId: randomUUID(), leaseId, fence },
      credential,
    );
    expect(alive.status, JSON.stringify(alive.body)).toBe(200);

    // An administrator switches the agent off. The delegation is untouched.
    await fixture.db.admin.execute(
      `update public.actors set active = false, deactivated_at = now()
        where business_id = $1 and id = $2`,
      [fixture.business, fixture.agentActorId],
    );
    const before = await leaseRow(leaseId);
    expect(before[0]?.['state']).toBe('live');
    const attemptsBefore = await refusedAgentAttempts();

    const operationId = randomUUID();
    const refused = await asAgent('task.heartbeat', { operationId, leaseId, fence }, credential);
    expect(refused.status, JSON.stringify(refused.body)).toBe(401);
    expect(refused.body).toMatchObject({ refused: true, code: 'AUTH_NO_AGENT_IDENTITY' });

    // The same answer a subject with no login here receives, byte for byte.
    const stranger = await asAgent(
      'task.heartbeat',
      { operationId: randomUUID(), leaseId, fence },
      credential,
      await tokenFor(`stranger-${randomUUID()}`),
    );
    expect(refused).toStrictEqual(stranger);

    expect(await leaseRow(leaseId)).toEqual(before);
    // One refused attempt for the deactivated agent, one for the stranger.
    expect(await refusedAgentAttempts()).toBe(attemptsBefore + 2);
    const registered = await fixture.db.admin.execute(
      `select 1 from public.operations where business_id = $1 and operation_id = $2`,
      [fixture.business, operationId],
    );
    expect(registered).toHaveLength(0);
  }, 120_000);
});
