// SPDX-License-Identifier: AGPL-3.0-only
//
// The five runtime operations, driven over HTTP the way a caller drives them.
//
// `tests/commands/task-runtime.test.ts` and `tests/commands/agent-path.test.ts`
// prove the same journey at the envelope level: they call `executeCommand` and
// `executeAgentCommand` directly, with the business identifier and the verified
// subject already in hand. Nothing in them goes through a route, a bearer token
// or a path prefix, so nothing in them proves the three things this file owes:
// that each operation is reachable at its own path, that the person prefix and
// the agent prefix answer differently for the same credential, and that the
// state the journey leaves behind is in the database rather than in the
// process that wrote it.
//
// Every case below runs the real `createApi` through `app.fetch`, over a
// throwaway database migrated from empty, with real HS256 bearers the real
// Supabase adapter verifies. Nothing is substituted except the port.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { pathOf } from '../../packages/core-records/src/commands/surface.ts';
import { gateSigningKey } from '../../packages/core-records/src/commands/runtime-config.ts';
import { enrol } from '../commands/fixture.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('api/runtime: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

/** The person prefix, and the agent's own. Both derive the tail from the surface. */
const personPath = (name: Parameters<typeof pathOf>[0]): string =>
  `/api/b/${BUSINESS_KEY}${pathOf(name)}`;
const agentPath = (name: Parameters<typeof pathOf>[0]): string =>
  `/api/a/b/${BUSINESS_KEY}${pathOf(name)}`;

const detailOf = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] as Record<string, unknown> | undefined) ?? {};

describe.skipIf(serverUrl === undefined)('the five runtime operations over HTTP', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let personToken: string;
  let agentToken: string;

  beforeAll(async () => {
    fixture = await createApiFixture('n');
    api = fixture.compose();
    personToken = await tokenFor(fixture.member.presented.subject);
    agentToken = await tokenFor(fixture.agent.subject);
  }, 120_000);

  afterAll(async () => {
    await fixture?.drop();
  });

  /** A command on the person prefix, as the browser client sends one. */
  async function asPerson(
    name: Parameters<typeof pathOf>[0],
    body: Readonly<Record<string, unknown>>,
    token: string = personToken,
  ): Promise<Answer> {
    return await post(api, personPath(name), body, authorised(token));
  }

  /** A command on the agent prefix, with the delegation beside the request. */
  async function asAgent(
    name: Parameters<typeof pathOf>[0],
    body: Readonly<Record<string, unknown>>,
    credential?: string,
    instance: Hono = api,
  ): Promise<Answer> {
    return await post(instance, agentPath(name), body, {
      ...authorised(agentToken),
      ...(credential === undefined ? {} : { 'x-agent-delegation': credential }),
    });
  }

  async function createTask(title: string): Promise<{ id: string; revision: number }> {
    const answer = await asPerson('task.create', {
      operationId: randomUUID(),
      fields: { title },
    });
    if (answer.status !== 200) {
      throw new Error(`task.create answered ${answer.status} ${JSON.stringify(answer.body)}`);
    }
    return { id: String(answer.body['recordId']), revision: Number(answer.body['revision']) };
  }

  async function proposeOn(
    task: { id: string; revision: number },
    purpose = 'draft_the_reply',
  ): Promise<Answer> {
    return await asPerson('task.propose', {
      operationId: randomUUID(),
      recordId: task.id,
      expectedRevision: task.revision,
      purpose,
      maximumMinor: 2_500,
      currency: 'AUD',
      payload: { instruction: 'draft a reply to the client' },
      step: { kind: 'compose', payload: { tone: 'plain' } },
    });
  }

  /**
   * Propose and approve as a person, so there is a reservation to pick up.
   *
   * The purpose is the caller's because `delegations_one_live_per_purpose_idx`
   * lets one agent actor hold one live delegation per purpose: two cases that
   * both picked up under `draft_the_reply` would be testing that index rather
   * than the route.
   */
  async function approvedReservation(
    title: string,
    purpose = 'draft_the_reply',
  ): Promise<{
    readonly taskId: string;
    readonly reservationId: string;
  }> {
    const task = await createTask(title);
    const proposed = await proposeOn(task, purpose);
    if (proposed.status !== 200) {
      throw new Error(`task.propose answered ${proposed.status}`);
    }
    const proposal = detailOf(proposed);
    const decided = await asPerson('task.decide', {
      operationId: randomUUID(),
      gateId: proposal['gateId'],
      versionId: proposal['versionId'],
      decision: 'approve',
      note: 'approved so an agent can work it',
    });
    if (decided.status !== 200) {
      throw new Error(`task.decide answered ${decided.status} ${JSON.stringify(decided.body)}`);
    }
    return { taskId: task.id, reservationId: String(detailOf(decided)['reservationId']) };
  }

  describe('task.propose', () => {
    it('makes a proposal at its own path and hands back the version to decide on', async () => {
      const task = await createTask('a task to propose against');
      const answer = await proposeOn(task);

      expect(answer.status).toBe(200);
      expect(answer.body['command']).toBe('task.propose');
      const detail = detailOf(answer);
      expect(String(detail['lineageId'])).toMatch(/^[0-9a-f-]{36}$/u);
      expect(detail['version']).toBe(1);
      expect(String(detail['payloadDigest'])).toHaveLength(64);
      expect(String(detail['gateId'])).toMatch(/^[0-9a-f-]{36}$/u);
    });

    it('refuses a proposal written against a revision the task has moved past', async () => {
      const task = await createTask('a task somebody else edited first');
      const answer = await asPerson('task.propose', {
        operationId: randomUUID(),
        recordId: task.id,
        // The revision this caller holds is not the one the record is on.
        expectedRevision: task.revision + 99,
        purpose: 'draft_the_reply',
        maximumMinor: 2_500,
        currency: 'AUD',
        payload: { instruction: 'draft a reply' },
        step: { kind: 'compose', payload: {} },
      });

      expect(answer.status).toBe(409);
      expect(answer.body['refused']).toBe(true);
      expect(answer.body['code']).toBe('VERSION_STALE');
    });
  });

  describe('task.decide', () => {
    it('approves the exact version and answers with the reservation it held', async () => {
      const task = await createTask('a task to approve');
      const proposal = detailOf(await proposeOn(task));

      const answer = await asPerson('task.decide', {
        operationId: randomUUID(),
        gateId: proposal['gateId'],
        versionId: proposal['versionId'],
        decision: 'approve',
        note: 'go ahead',
      });

      expect(answer.status).toBe(200);
      const detail = detailOf(answer);
      expect(detail['decision']).toBe('approve');
      expect(String(detail['reservationId'])).toMatch(/^[0-9a-f-]{36}$/u);
      expect(detail['heldMinor']).toBe(2_500);
      expect(String(detail['hash'])).toHaveLength(64);
    });

    it('refuses a second decision on a gate that has already been decided', async () => {
      const task = await createTask('a task two people decide');
      const proposal = detailOf(await proposeOn(task));
      const decide = (note: string): Promise<Answer> =>
        asPerson('task.decide', {
          operationId: randomUUID(),
          gateId: proposal['gateId'],
          versionId: proposal['versionId'],
          decision: 'approve',
          note,
        });

      expect((await decide('first')).status).toBe(200);
      const loser = await decide('second');

      expect(loser.status).toBe(409);
      expect(loser.body['refused']).toBe(true);
      expect(loser.body['code']).toBe('GATE_ALREADY_DECIDED');
    });
  });

  describe('task.queue', () => {
    it('shows the approved work nobody has picked up', async () => {
      const { reservationId } = await approvedReservation('a task on the queue');
      const answer = await asPerson('task.queue', {});

      expect(answer.status).toBe(200);
      const queue = answer.body['queue'] as readonly Record<string, unknown>[];
      expect(queue.map((entry) => entry['reservationId'])).toContain(reservationId);
    });

    it('refuses a member of the business who holds no grant on tasks', async () => {
      // Enrolled, mapped and a member: everything except the authority. A read
      // refused for want of a grant is a refusal and not an empty queue.
      const stranger = await enrol(fixture.db.app, fixture.business, 'ungranted');
      const answer = await asPerson('task.queue', {}, await tokenFor(stranger.presented.subject));

      expect(answer.status).toBe(403);
      expect(answer.body['refused']).toBe(true);
      expect(answer.body['code']).toBe('SCOPE_NOT_GRANTED');
    });
  });

  describe('task.pickup', () => {
    it('lets an agent claim a reservation on the agent prefix and mints it a delegation', async () => {
      const { taskId, reservationId } = await approvedReservation(
        'work an agent will claim',
        'draft_the_reply_pickup',
      );
      const answer = await asAgent('task.pickup', {
        operationId: randomUUID(),
        reservationId,
      });

      expect(answer.status).toBe(200);
      const detail = detailOf(answer);
      expect(detail['taskId']).toBe(taskId);
      expect(detail['reservationId']).toBe(reservationId);
      expect(String(detail['credential']).length).toBeGreaterThan(20);
      expect(String(detail['leaseId'])).toMatch(/^[0-9a-f-]{36}$/u);
      expect((detail['purposeScope'] as { readonly id: string }).id).toBe(taskId);
    });

    it('refuses a reservation with no approval behind it', async () => {
      const answer = await asAgent('task.pickup', {
        operationId: randomUUID(),
        reservationId: randomUUID(),
      });

      expect(answer.status).toBe(409);
      expect(answer.body['refused']).toBe(true);
      expect(answer.body['code']).toBe('RESERVATION_NOT_CLAIMABLE');
    });
  });

  describe('task.handback', () => {
    it('settles the lease the pickup handed out', async () => {
      const { reservationId } = await approvedReservation(
        'work handed back at once',
        'draft_the_reply_handback',
      );
      const picked = detailOf(
        await asAgent('task.pickup', { operationId: randomUUID(), reservationId }),
      );

      const handedBack = await asAgent(
        'task.handback',
        {
          operationId: randomUUID(),
          leaseId: picked['leaseId'],
          fence: picked['fence'],
          outcome: 'completed',
          report: { wrote: 'a draft' },
        },
        String(picked['credential']),
      );

      expect(handedBack.status).toBe(200);
      expect(detailOf(handedBack)['reservationId']).toBe(reservationId);
      expect(detailOf(handedBack)['reservationState']).toBe('abandoned');
    });

    it('refuses a handback presented without a live delegation', async () => {
      const answer = await asAgent('task.handback', {
        operationId: randomUUID(),
        leaseId: randomUUID(),
        fence: 1,
        outcome: 'completed',
      });

      expect(answer.status).toBe(401);
      expect(answer.body['refused']).toBe(true);
      expect(answer.body['code']).toBe('DELEGATION_NOT_LIVE');
    });
  });

  describe('the two prefixes are two doors', () => {
    it('refuses a person presenting themselves on the agent prefix', async () => {
      const answer = await post(
        api,
        agentPath('task.queue'),
        { operationId: randomUUID() },
        authorised(personToken),
      );

      expect(answer.status).toBe(401);
      expect(answer.body['code']).toBe('AUTH_NO_AGENT_IDENTITY');
    });

    it('refuses an agent on the person prefix, for want of a membership', async () => {
      // A login mapped to an agent actor is in `actor_logins` and in no person
      // table, so the person path finds no membership rather than no authority.
      const answer = await post(
        api,
        personPath('task.create'),
        { operationId: randomUUID(), fields: { title: 'nope' } },
        authorised(agentToken),
      );

      expect(answer.status).toBe(403);
      expect(answer.body['code']).toBe('AUTH_NO_MEMBERSHIP');
    });

    it('answers an expired bearer with the re-login code on both prefixes', async () => {
      const expired = await tokenFor(fixture.member.presented.subject, { expiresIn: -60 });
      const expiredAgent = await tokenFor(fixture.agent.subject, { expiresIn: -60 });

      const person = await post(
        api,
        personPath('task.queue'),
        { operationId: randomUUID() },
        authorised(expired),
      );
      expect(person.status).toBe(401);
      expect(person.body['code']).toBe('AUTH_SESSION_EXPIRED');

      const agent = await post(
        api,
        agentPath('task.queue'),
        { operationId: randomUUID() },
        authorised(expiredAgent),
      );
      expect(agent.status).toBe(401);
      expect(agent.body['code']).toBe('AUTH_SESSION_EXPIRED');
    });
  });

  describe('the journey survives a restart between pickup and handback', () => {
    it('finishes on a second composition root reading the same database', async () => {
      // **This is an in-process restart.** The second instance below is a fresh
      // composition root over the same database: a new `createApi`, a new
      // verifier, a new business resolver with an empty cache, and the gate key
      // read out of `process.env` again. It is not an operating-system restart
      // of the served API — that one is the coordinator's browser run against
      // the API on port 8790, where the process really is stopped and started.
      // What this case can prove is the part that would make that run pass or
      // fail: that the reservation, the lease and the attempt are read back out
      // of Postgres and not out of whatever the first instance remembered.
      const { taskId, reservationId } = await approvedReservation(
        'work that outlives a restart',
        'draft_the_reply_restart',
      );

      const picked = detailOf(
        await asAgent('task.pickup', { operationId: randomUUID(), reservationId }),
      );
      const credential = String(picked['credential']);
      const leaseId = String(picked['leaseId']);
      const fence = Number(picked['fence']);
      expect(picked['taskId']).toBe(taskId);

      // The restart. Nothing the first instance holds is carried across: the
      // gate values are cleared so the second composition root has to put them
      // back, exactly as `server.ts` does from the deployment's own file.
      delete process.env['GATE_SIGNING_KEY_ID'];
      delete process.env['GATE_SIGNING_SECRET'];
      expect(gateSigningKey()).toBeUndefined();

      const restarted = fixture.compose();
      expect(restarted).not.toBe(api);
      expect(gateSigningKey()).toBeDefined();

      // The second instance was handed no reservation, no lease and no fence.
      // It knows about this work only because Postgres does: the queue read on
      // the fresh instance no longer shows the reservation, because the pickup
      // the *first* instance served took it off.
      const queue = await post(restarted, personPath('task.queue'), {}, authorised(personToken));
      expect(queue.status).toBe(200);
      const entries = queue.body['queue'] as readonly Record<string, unknown>[];
      expect(entries.map((entry) => entry['reservationId'])).not.toContain(reservationId);

      // And the delegation the first instance minted is still live on the
      // second, which is the same claim from the other side: a credential
      // checked against process memory would have died with the first root.
      const read = await asAgent(
        'task.read',
        { operationId: randomUUID(), recordId: taskId },
        credential,
        restarted,
      );
      expect(read.status).toBe(200);

      const handedBack = await asAgent(
        'task.handback',
        {
          operationId: randomUUID(),
          leaseId,
          fence,
          outcome: 'completed',
          report: { wrote: 'a draft, across a restart' },
        },
        credential,
        restarted,
      );
      expect(handedBack.status).toBe(200);
      const settled = detailOf(handedBack);
      expect(settled['leaseId']).toBe(leaseId);
      expect(settled['reservationId']).toBe(reservationId);
      expect(settled['reservationState']).toBe('abandoned');
      expect(settled['envelopeActualMinor']).toBe(0);

      // The rows themselves, read on the administrative connection rather than
      // taken from the answer. A handback that only moved what the second
      // instance held in memory would pass every assertion above and fail these.
      const rows = await fixture.db.admin.execute<{
        readonly reservation_state: string;
        readonly lease_state: string;
        readonly attempt_state: string;
        readonly lease_fence: string;
      }>(
        `select res.state as reservation_state,
                l.state as lease_state,
                a.state as attempt_state,
                l.fence::text as lease_fence
           from public.reservations res
           join public.leases l on l.business_id = res.business_id and l.id = $2
           join public.attempts a on a.business_id = res.business_id and a.reservation_id = res.id
          where res.business_id = $1 and res.id = $3`,
        [fixture.business, leaseId, reservationId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.reservation_state).toBe('abandoned');
      expect(rows[0]?.lease_state).not.toBe('live');
      expect(rows[0]?.attempt_state).not.toBe('reserved');
      expect(Number(rows[0]?.lease_fence)).toBe(fence);

      // The delegation is settled with the lease, so the next call on the
      // second instance collapses. One journey, two roots, one database.
      const afterwards = await asAgent(
        'task.read',
        { operationId: randomUUID(), recordId: taskId },
        credential,
        restarted,
      );
      expect(afterwards.status).toBe(401);
      expect(afterwards.body['code']).toBe('DELEGATION_NOT_LIVE');
    }, 60_000);
  });
});
