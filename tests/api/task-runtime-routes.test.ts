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

/** The successor's caller-supplied half. The actor is never in it. */
const successorBody = (maximumMinor: number): Readonly<Record<string, unknown>> => ({
  purpose: 'draft_the_reply',
  maximumMinor,
  currency: 'AUD',
  payload: { instruction: 'the client asked for a second pass' },
  step: { kind: 'compose', payload: { tone: 'plain' } },
});

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

    /**
     * The duplicate live delegation, over the surface (lane L2-DELEGATION-FIX,
     * item 1). `delegations_one_live_per_purpose_idx` (0008:195) is keyed on
     * `(business_id, agent_actor_id, purpose)` and not on the purpose scope,
     * so the duplicate an agent can actually reach through a command is a
     * second pickup under a purpose word it still holds — a *different*
     * reservation. A second pickup of the same reservation never gets that
     * far: its live lease refuses it as `RESERVATION_NOT_CLAIMABLE` above.
     *
     * Before the fix this answered 500 `{"raw":"Internal Server Error"}` with
     * the serving transaction aborted and no audit row.
     *
     * **Still `it.fails` on this branch, and for a different reason from the
     * one it used to fail for.** `mintDelegation` now returns the refusal --
     * `tests/identity` proves that -- but `DELEGATION_ALREADY_LIVE` is not in
     * `commands/register.ts`'s `RefusalCode` union or in `apps/api/status.ts`,
     * and those are lane L3-PART-B-3's files, registered on a sibling branch
     * (its addendum 1). An unregistered code raises in `agent-envelope.ts:145`
     * and the envelope still answers **500**, which is the status observed
     * here. The moment the two branches meet this case starts failing and must
     * be flipped to a plain `it`; the assertions below are already the ones it
     * should then hold, including 409 via the register's status map.
     */
    it.fails(
      'refuses a second live delegation for one purpose instead of faulting',
      async () => {
        const first = await approvedReservation('work under a held purpose', 'draft_the_reply_dup');
        const held = await asAgent('task.pickup', {
          operationId: randomUUID(),
          reservationId: first.reservationId,
        });
        expect(held.status).toBe(200);
        const firstDetail = detailOf(held);

        const sibling = await approvedReservation('more work, same purpose', 'draft_the_reply_dup');
        const operationId = randomUUID();
        const again = await asAgent('task.pickup', {
          operationId,
          reservationId: sibling.reservationId,
        });

        // A decision, not an outage: a refusal shape, and neither 500 nor 503.
        expect(again.status).not.toBe(500);
        expect(again.status).not.toBe(503);
        expect(again.body['refused']).toBe(true);
        expect(again.body['code']).toBe('DELEGATION_ALREADY_LIVE');

        // The first hold is untouched: still one lease, and its credential works.
        const read = await asAgent(
          'task.read',
          { operationId: randomUUID(), recordId: first.taskId },
          String(firstDetail['credential']),
        );
        expect(read.status).toBe(200);

        // And the serving transaction committed, so the attempt is in the chain.
        const audited = await fixture.db.app.withBusiness(fixture.business, async (tx) =>
          tx.query<{ readonly outcome: string; readonly refusal_code: string | null }>(
            `select outcome, refusal_code from public.audit_events
            where business_id = $1 and operation_id = $2`,
            [fixture.business, operationId],
          ),
        );
        expect(audited.length).toBe(1);
        expect(audited[0]?.refusal_code).toBe('DELEGATION_ALREADY_LIVE');
      },
      60_000,
    );

    /**
     * Behavioural note 10 from lane L4-RUNTIME-FIX, now the assertions rather
     * than the `it.fails` that recorded it: a pickup of a reservation whose
     * lease expired succeeds and hands back a *different* reservation and
     * attempt from the ones asked for, with the abandoned hold shown beside
     * the fresh one.
     *
     * What unblocked it is item 1's guard. The delegation expires with the
     * lease, and expiry is not in the index's predicate, so the spent
     * delegation went on occupying the slot; `mintDelegation` now settles it
     * in the same transaction as the new hold, so the index is satisfied by
     * one row and the abandoned credential answers `DELEGATION_NOT_LIVE`.
     */
    it('recovers an expired lease into a fresh hold with new identifiers', async () => {
      const { taskId, reservationId } = await approvedReservation(
        'work whose lease runs out',
        'draft_the_reply_expiry',
      );
      const first = detailOf(
        await asAgent('task.pickup', {
          operationId: randomUUID(),
          reservationId,
          leaseSeconds: 1,
        }),
      );
      expect(first['reservationId']).toBe(reservationId);

      // The shortest lease the surface allows, waited out. The expiry is the
      // server's own clock, so there is nothing to fake here.
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      const again = await asAgent('task.pickup', { operationId: randomUUID(), reservationId });
      expect(again.status).toBe(200);
      const second = detailOf(again);
      expect(second['reservationId']).not.toBe(reservationId);
      expect(second['attemptId']).not.toBe(first['attemptId']);

      // The old credential is spent; the new one works.
      const stale = await asAgent(
        'task.read',
        { operationId: randomUUID(), recordId: taskId },
        String(first['credential']),
      );
      expect(stale.body['code']).toBe('DELEGATION_NOT_LIVE');

      const fresh = await asAgent(
        'task.read',
        { operationId: randomUUID(), recordId: taskId },
        String(second['credential']),
      );
      expect(fresh.status).toBe(200);

      // The projection shows the abandoned hold beside the fresh one.
      const holds = await fixture.db.app.withBusiness(fixture.business, async (tx) =>
        tx.query<{ readonly id: string; readonly state: string }>(
          `select res.id, res.state from public.reservations res
             join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
            where res.business_id = $1 and run.task_id = $2`,
          [fixture.business, taskId],
        ),
      );
      expect(holds.length).toBe(2);
      expect(holds.find((row) => row.id === reservationId)?.state).not.toBe('held');
      expect(holds.find((row) => row.id === second['reservationId'])?.state).toBe('held');
    }, 60_000);

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

    // Behavioural note 7 from lane L4-RUNTIME-FIX, over HTTP. The unit cases
    // in tests/commands/handback-expenditure.test.ts prove the guard; this
    // proves a real caller meets it and that the lease it holds survives.
    it('refuses a reported expenditure rather than dropping the key', async () => {
      const { reservationId } = await approvedReservation(
        'work whose cost is claimed',
        'draft_the_reply_expenditure',
      );
      const picked = detailOf(
        await asAgent('task.pickup', { operationId: randomUUID(), reservationId }),
      );

      const answer = await asAgent(
        'task.handback',
        {
          operationId: randomUUID(),
          leaseId: picked['leaseId'],
          fence: picked['fence'],
          outcome: 'completed',
          actualMinor: 0,
          report: { wrote: 'a draft it says cost nothing' },
        },
        String(picked['credential']),
      );

      expect(answer.status).toBe(422);
      expect(answer.body['code']).toBe('ACTUAL_EXPENDITURE_UNSUPPORTED');
      expect(answer.body['names']).toEqual(['actualMinor']);
      // Refused before the first write, so nothing was retained and the lease
      // the agent holds is still the live one it can hand back under.
      const kept = await fixture.db.admin.execute<{ readonly reports: string }>(
        `select count(*)::text as reports from public.handback_reports
          where business_id = $1 and lease_id = $2`,
        [fixture.business, picked['leaseId']],
      );
      expect(kept[0]?.reports).toBe('0');
      const proper = await asAgent(
        'task.handback',
        {
          operationId: randomUUID(),
          leaseId: picked['leaseId'],
          fence: picked['fence'],
          outcome: 'completed',
        },
        String(picked['credential']),
      );
      expect(proper.status).toBe(200);
    });

    // Behavioural note 8, and the one refusal in the surface that commits.
    it('keeps the retained report when a stale fence is refused', async () => {
      const { reservationId } = await approvedReservation(
        'work handed back on a stale fence',
        'draft_the_reply_stale_fence',
      );
      const picked = detailOf(
        await asAgent('task.pickup', { operationId: randomUUID(), reservationId }),
      );
      const stale = Number(picked['fence']) + 1;

      const answer = await asAgent(
        'task.handback',
        {
          operationId: randomUUID(),
          leaseId: picked['leaseId'],
          fence: stale,
          outcome: 'completed',
          report: { wrote: 'work a stale holder really did' },
        },
        String(picked['credential']),
      );

      expect(answer.body['refused']).toBe(true);
      expect(answer.body['code']).toBe('LEASE_NOT_OWNED');

      // The point of the case. Every other refusal in the surface rolls its
      // handler's savepoint back; this one releases it, because L4's `handback`
      // wrote the report *before* refusing and the contract keeps it. Read on
      // the administrative connection after the serving transaction committed:
      // if the savepoint had rolled back, this is zero rows.
      const rows = await fixture.db.admin.execute<{
        readonly disposition: string;
        readonly refusal_code: string;
        readonly fence: string;
      }>(
        `select disposition, refusal_code, fence::text as fence
           from public.handback_reports
          where business_id = $1 and lease_id = $2`,
        [fixture.business, picked['leaseId']],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.disposition).toBe('retained');
      expect(rows[0]?.refusal_code).toBe('LEASE_NOT_OWNED');
      expect(Number(rows[0]?.fence)).toBe(stale);

      // Retained, not settled: the lease is untouched and the rightful holder
      // can still hand back under the fence it owns.
      const proper = await asAgent(
        'task.handback',
        {
          operationId: randomUUID(),
          leaseId: picked['leaseId'],
          fence: picked['fence'],
          outcome: 'completed',
        },
        String(picked['credential']),
      );
      expect(proper.status).toBe(200);
      expect(detailOf(proper)['reservationState']).toBe('abandoned');
    });
  });

  // T4's successor half, over HTTP. The runtime already writes the successor
  // under the handback's own locks; what these cases prove is the surface:
  // that a caller can ask for one, that the four durable handles come back in
  // the same answer as the settlement, and that an out-of-bounds successor
  // settles nothing at all.
  describe('task.handback and its successor', () => {
    it('hands back four null handles when no successor is asked for', async () => {
      const { reservationId } = await approvedReservation(
        'work handed back with nothing to follow it',
        'draft_the_reply_no_successor',
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
          report: { wrote: 'a draft that finished the job' },
        },
        String(picked['credential']),
      );

      expect(handedBack.status).toBe(200);
      const settled = detailOf(handedBack);
      // The settlement is exactly what it was before the successor existed.
      expect(settled['reservationId']).toBe(reservationId);
      expect(settled['reservationState']).toBe('abandoned');
      expect(String(settled['reportId'])).toMatch(/^[0-9a-f-]{36}$/u);
      // All four together, because "no successor" is one fact and not four.
      expect(settled['successorVersionId']).toBeNull();
      expect(settled['successorGateId']).toBeNull();
      expect(settled['successorRunId']).toBeNull();
      expect(settled['successorStepId']).toBeNull();

      const gates = await fixture.db.admin.execute<{ readonly pending: string }>(
        `select count(*)::text as pending
           from public.gates g
           join public.proposal_versions v
             on v.business_id = g.business_id and v.id = g.version_id
           join public.planned_runs r
             on r.business_id = v.business_id and r.lineage_id = v.lineage_id
          where g.business_id = $1 and g.state = 'pending' and r.id = $2`,
        [fixture.business, picked['runId']],
      );
      expect(gates[0]?.pending).toBe('0');
    });

    it('settles and proposes the successor in one transaction', async () => {
      const { reservationId } = await approvedReservation(
        'work that asks for a second round',
        'draft_the_reply_successor',
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
          report: { wrote: 'a draft, and it needs another pass' },
          successor: successorBody(2_500),
        },
        String(picked['credential']),
      );

      expect(handedBack.status).toBe(200);
      const settled = detailOf(handedBack);
      expect(settled['reservationState']).toBe('abandoned');
      for (const handle of [
        'successorVersionId',
        'successorGateId',
        'successorRunId',
        'successorStepId',
      ]) {
        expect(String(settled[handle]), handle).toMatch(/^[0-9a-f-]{36}$/u);
      }

      // The point of the case. One read, on the administrative connection,
      // after the serving transaction committed: the successor's pending gate
      // and the handback's settled report in the same row. If either half had
      // been committed without the other this query returns nothing.
      const together = await fixture.db.admin.execute<{
        readonly gate_state: string;
        readonly round: string;
        readonly proposed_by: string;
        readonly maximum_minor: string;
        readonly disposition: string;
        readonly report_outcome: string;
      }>(
        `select g.state as gate_state, g.round::text as round,
                v.proposed_by_actor_id as proposed_by,
                v.maximum_minor::text as maximum_minor,
                h.disposition, h.outcome as report_outcome
           from public.gates g
           join public.proposal_versions v
             on v.business_id = g.business_id and v.id = g.version_id
           cross join public.handback_reports h
          where g.business_id = $1 and g.id = $2
            and h.business_id = $1 and h.id = $3`,
        [fixture.business, settled['successorGateId'], settled['reportId']],
      );
      expect(together).toHaveLength(1);
      expect(together[0]?.gate_state).toBe('pending');
      expect(together[0]?.disposition).toBe('settled');
      expect(together[0]?.report_outcome).toBe('completed');
      expect(together[0]?.maximum_minor).toBe('2500');
      // The agent actor of the session, never a value the body supplied.
      expect(together[0]?.proposed_by).toBe(fixture.agentActorId);
    });

    it('refuses a body that names the actor the successor is proposed by', async () => {
      const { reservationId } = await approvedReservation(
        'work whose successor claims an author',
        'draft_the_reply_successor_actor',
      );
      const picked = detailOf(
        await asAgent('task.pickup', { operationId: randomUUID(), reservationId }),
      );

      const answer = await asAgent(
        'task.handback',
        {
          operationId: randomUUID(),
          leaseId: picked['leaseId'],
          fence: picked['fence'],
          outcome: 'completed',
          successor: { ...successorBody(2_500), proposedByActorId: fixture.member.actorId },
        },
        String(picked['credential']),
      );

      expect(answer.body['refused']).toBe(true);
      expect(answer.body['code']).toBe('FIELD_NOT_WRITABLE');
      expect(answer.body['names']).toEqual(['successor.proposedByActorId']);
    });

    it('refuses an out-of-bounds successor and settles nothing', async () => {
      const { reservationId } = await approvedReservation(
        'work whose successor asks for more than the cap holds',
        'draft_the_reply_successor_bounds',
      );
      const picked = detailOf(
        await asAgent('task.pickup', { operationId: randomUUID(), reservationId }),
      );

      const answer = await asAgent(
        'task.handback',
        {
          operationId: randomUUID(),
          leaseId: picked['leaseId'],
          fence: picked['fence'],
          outcome: 'completed',
          report: { wrote: 'a draft, and then asked for the moon' },
          successor: successorBody(5_000_000),
        },
        String(picked['credential']),
      );

      expect(answer.status).toBe(409);
      expect(answer.body['refused']).toBe(true);
      expect(answer.body['code']).toBe('SUCCESSOR_OUT_OF_BOUNDS');

      // Unlike the stale-fence refusals, this one keeps nothing: the lease is
      // still live, the hold is still held and no report was written. Read on
      // the administrative connection after the serving transaction ended.
      const rows = await fixture.db.admin.execute<{
        readonly lease_state: string;
        readonly still_running: boolean;
        readonly reservation_state: string;
        readonly reports: string;
        readonly pending_gates: string;
      }>(
        `select l.state as lease_state, (l.expires_at > now()) as still_running,
                res.state as reservation_state,
                (select count(*) from public.handback_reports h
                  where h.business_id = l.business_id and h.lease_id = l.id)::text as reports,
                (select count(*) from public.gates g
                   join public.proposal_versions v
                     on v.business_id = g.business_id and v.id = g.version_id
                   join public.planned_runs r
                     on r.business_id = v.business_id and r.lineage_id = v.lineage_id
                  where g.business_id = l.business_id and g.state = 'pending'
                    and r.id = l.run_id)::text as pending_gates
           from public.leases l
           join public.reservations res
             on res.business_id = l.business_id and res.id = l.reservation_id
          where l.business_id = $1 and l.id = $2`,
        [fixture.business, picked['leaseId']],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.lease_state).toBe('live');
      expect(rows[0]?.still_running).toBe(true);
      expect(rows[0]?.reservation_state).toBe('held');
      expect(rows[0]?.reports).toBe('0');
      expect(rows[0]?.pending_gates).toBe('0');

      // And the holder can still hand back under the fence it owns.
      const proper = await asAgent(
        'task.handback',
        {
          operationId: randomUUID(),
          leaseId: picked['leaseId'],
          fence: picked['fence'],
          outcome: 'completed',
        },
        String(picked['credential']),
      );
      expect(proper.status).toBe(200);
      expect(detailOf(proper)['reservationState']).toBe('abandoned');
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
