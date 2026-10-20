// SPDX-License-Identifier: AGPL-3.0-only
//
// ROUTE1905 (#2112): the worker also works a plan the owner proposed and
// accepted on the task its own delegation names, so the agent drafts on the
// owner's plan. The run its pickup takes reaches `model.call` on the plan
// route and is carried there, because the owner started it (#1620 P4). A
// member's proposal, another business's plan and a plan on another
// delegation's task stay queued, and a revoked delegation picks nothing up.
// The worker's own proposal still runs as it did on a key, and the plan route
// still refuses it: an agent-proposed run is never owner-started, and that
// refusal ends its attempt cancelled (#1623 R1, B2). The worker runs
// against the served API over a real database, and each plan call goes
// through the real broker and custody, the replay provider answering for the
// plan's host. The last six cases are review S2113's proofs.

/* eslint-disable max-lines -- one served API and broker, a case per crossing */
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { writeAuditEvent } from '../../packages/core-commands/src/commands/audit.ts';
import {
  catalogue,
  CHATGPT_PLAN_PROVIDER,
  REPLAY_COMPOSE,
  replayAdapter,
  replayCostMinor,
} from '../../packages/core-connectors/src/index.ts';
import {
  callModel,
  type Broker,
  type BrokerRoute,
  type ModelCallResult,
} from '../../packages/core-custody/src/index.ts';
import {
  mintChildDelegation,
  mintDelegation,
  revokeDelegation,
} from '../../packages/core-records/src/authority/delegations.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { readIdentity } from '../../apps/api/identity.ts';
import type { Transport } from '../../apps/cli/client.ts';
import { createWorker, SYNTHETIC_STEP } from '../../apps/worker/worker.ts';
import { SYNTHETIC_USAGE } from '../../apps/worker/usage.ts';
import { openCustodyWorld, type CustodyWorld } from '../custody/custody-world.ts';
import { attemptOfLease, outcomesOfAttempt } from '../runs/run-outcomes-read.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  approve as approveInBravo,
  createTask as createBravoTask,
  propose as proposeInBravo,
  seedSchedules,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from './fixture.ts';
import { COMPUTES_NOTHING } from '../support/computes-nothing-runner.ts';

const serverUrl = databaseUrlFromEnvironment();
const ROOT = resolve(import.meta.dirname, '../..');

if (serverUrl === undefined) {
  console.warn(
    'api/the-worker-runs-the-owners-accepted-plan-on-its-delegations-task: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Name = Parameters<typeof pathOf>[0];

const PLAN_COMPOSE = {
  ...REPLAY_COMPOSE,
  key: 'model.plan_compose',
  provider: CHATGPT_PLAN_PROVIDER,
};

const API_ROUTE: BrokerRoute = {
  key: 'replay',
  reach: 'cloud',
  provider: 'replay',
  credentialRef: 'replay_key',
  credentialKind: 'api_key',
  installation: 'here',
  ceiling: 1_000,
};

const PLAN_ROUTE: BrokerRoute = {
  ...API_ROUTE,
  key: 'chatgpt_plan',
  provider: CHATGPT_PLAN_PROVIDER,
  credentialKind: 'subscription',
};

/** `person` holding `role` from now on, as a role change is made: one membership ends, one starts. */
async function holdsRole(
  database: ApiFixture['db'],
  business: string,
  personId: string,
  role: string,
) {
  await database.admin.execute(
    `update public.memberships set active = false, ended_at = clock_timestamp()
      where business_id = $1 and person_id = $2 and active`,
    [business, personId],
  );
  await database.admin.execute(
    `insert into public.memberships (business_id, id, person_id, role_key, active, joined_at)
     values ($1, $2, $3, $4, true, clock_timestamp())`,
    [business, randomUUID(), personId, role],
  );
}

const detailOf = (answer: Answer): Record<string, unknown> => {
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body['detail'] as Record<string, unknown>;
};

/** What the worker's pickup handed it, and each broker call made while it held that lease. */
interface Pickup {
  readonly detail: Record<string, unknown>;
  readonly calls: ModelCallResult[];
}

// eslint-disable-next-line max-lines-per-function -- one served API and broker, every case on them
describe.skipIf(serverUrl === undefined)("the worker runs the owner's accepted plan", () => {
  let fixture: ApiFixture;
  let api: Hono;
  let custody: CustodyWorld;
  let ownerToken: string;
  let staffToken: string;
  let agentToken: string;
  let staff: Member;
  let bravo: Schedules;

  const transport: Transport = async (path, body, bearer, delegation) =>
    await api.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authorised(bearer),
        ...(delegation === undefined ? {} : { 'x-agent-delegation': delegation }),
      },
      body,
    });

  const as = async (token: string, name: Name, body: object): Promise<Answer> =>
    await post(api, `/api/b/${BUSINESS_KEY}${pathOf(name)}`, body, authorised(token));

  const brokerOn = (route: BrokerRoute): Broker => ({
    custody: custody.custody,
    operations: catalogue([REPLAY_COMPOSE, PLAN_COMPOSE]),
    providers: new Map([
      ['replay', { build: replayAdapter, price: replayCostMinor }],
      [CHATGPT_PLAN_PROVIDER, { build: replayAdapter, price: replayCostMinor }],
    ]),
    routes: [route],
    installation: 'here',
    audit: async (tx, note) => {
      await writeAuditEvent(tx, {
        actorId: fixture.agentActorId,
        command: note.action,
        outcome: note.outcome,
        refusalCode: note.refusalCode,
        payloadDigest: createHash('sha256').update(JSON.stringify(note.detail)).digest('hex'),
        attempted: note.outcome === 'refused' ? note.detail : null,
      });
    },
  });

  /** The run's first step under the lease the pickup took. */
  const stepOn = async (leaseId: string): Promise<string> => {
    const [row] = await fixture.db.admin.execute<{ id: string }>(
      `select st.id::text from public.planned_steps st join public.leases l on l.run_id = st.run_id
        where l.id = $1 order by st.ordinal limit 1`,
      [leaseId],
    );
    if (row === undefined) throw new Error('no step for the lease');
    return row.id;
  };

  /**
   * The served API, recording each pickup the worker makes. While it holds
   * the lease, before its dispatch is sent, the run asks the broker for a
   * compose on each of `routes` in turn, nobody attending: the model calls
   * the agent's turn makes there.
   */
  const callingOn =
    (routes: readonly BrokerRoute[], taskId: string, pickups: Pickup[]): Transport =>
    async (path, body, bearer, delegation) => {
      const held = pickups.at(-1);
      if (path.endsWith('/task/dispatch') && held !== undefined) {
        const leaseId = String(held.detail['leaseId']);
        const stepId = await stepOn(leaseId);
        for (const route of routes) {
          // Free text reaches only the owner's plan; a key carries a field a person of the business entered.
          const [operation, field] =
            route === PLAN_ROUTE ? [PLAN_COMPOSE, 'instruction'] : [REPLAY_COMPOSE, 'tone'];
          held.calls.push(
            // eslint-disable-next-line no-await-in-loop -- one call at a time on the lease
            await callModel(
              fixture.db.app,
              fixture.business,
              {
                actorId: fixture.agentActorId,
                delegationId: String(held.detail['delegationId']),
                attendedByPersonId: null,
              },
              {
                leaseId,
                fence: Number(held.detail['fence']),
                stepId,
                operation: operation.key,
                fields: [{ name: field, from: { recordId: taskId, key: 'title' } }],
              },
              brokerOn(route),
            ),
          );
        }
      }
      const response = await transport(path, body, bearer, delegation);
      if (path.endsWith('/task/pickup') && response.status === 200) {
        const answer = (await response.clone().json()) as { detail: Record<string, unknown> };
        pickups.push({ detail: answer.detail, calls: [] });
      }
      return response;
    };

  const workerOn = (through: Transport, delegation: string) =>
    createWorker({
      transport: through,
      businessKey: BUSINESS_KEY,
      credential: agentToken,
      delegation,
      reporter: SYNTHETIC_USAGE,
      runner: COMPUTES_NOTHING,
    });

  /** The agent's delegation scoped to `taskId`, as its operator mints it. */
  async function delegationOn(taskId: string) {
    return await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      const minted = await mintDelegation(tx, {
        agentActorId: fixture.agentActorId,
        delegatePersonId: fixture.member.personId,
        mintedByActorId: fixture.member.actorId,
        purpose: `owner_plan_${randomUUID().slice(0, 8)}`,
        collections: ['task'],
        actions: ['read', 'comment', 'write'],
        purposeScope: { kind: 'record', id: taskId },
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
      return { credential: minted.value.credential, delegationId: minted.value.delegation.id };
    });
  }

  /** A task the owner created, with no client, and the agent's delegation on it. */
  async function ownersTask() {
    const created = await as(ownerToken, 'task.create', {
      operationId: randomUUID(),
      fields: { title: `About page hours ${randomUUID()}` },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const taskId = String(created.body['recordId']);
    return { taskId, revision: created.body['revision'], ...(await delegationOn(taskId)) };
  }

  /** The worker's step proposed on `taskId` by `proposer`, and accepted by the owner. */
  async function acceptedPlan(proposer: string, taskId: string, revision: unknown) {
    const proposed = detailOf(
      await as(proposer, 'task.propose', {
        operationId: randomUUID(),
        recordId: taskId,
        expectedRevision: revision,
        purpose: SYNTHETIC_STEP.kind,
        maximumMinor: 2_500,
        currency: 'AUD',
        payload: { change: 'update the About page hours' },
        step: SYNTHETIC_STEP,
      }),
    );
    return await ownerAccepts(proposed);
  }

  async function ownerAccepts(proposed: Record<string, unknown>) {
    const decided = detailOf(
      await as(ownerToken, 'task.decide', {
        operationId: randomUUID(),
        gateId: proposed['gateId'],
        versionId: proposed['versionId'],
        decision: 'approve',
        note: 'go ahead',
      }),
    );
    expect(decided['reservationId']).toEqual(expect.any(String));
    return String(decided['reservationId']);
  }

  const reservation = async (reservationId: string) =>
    (
      await fixture.db.admin.execute<{ state: string; lease_id: string | null }>(
        'select state, lease_id::text from public.reservations where id = $1',
        [reservationId],
      )
    )[0];

  const callsOn = async (leaseId: unknown) =>
    await fixture.db.admin.execute<Record<string, unknown>>(
      `select state, route_key, credential_kind, refusal_code from public.model_calls
        where lease_id = $1 order by accepted_at, id`,
      [leaseId],
    );

  beforeAll(async () => {
    fixture = await createApiFixture('worker_owner_plan');
    api = fixture.compose(undefined, readIdentity(ROOT));
    await holdsRole(fixture.db, fixture.business, fixture.member.personId, 'owner');
    staff = await enrol(fixture.db.app, fixture.business, 'staff');
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      for (const action of ['read', 'write'] as const) {
        // eslint-disable-next-line no-await-in-loop -- `issueGrant` reads the granter's own rows
        await grantTo(tx, staff, action);
      }
    });
    ownerToken = await tokenFor(fixture.member.presented.subject);
    staffToken = await tokenFor(staff.presented.subject);
    agentToken = await tokenFor(fixture.agent.subject);
    await fixture.db.admin.execute(
      'update public.budget_caps set limit_minor = 1000000000 where business_id = $1',
      [fixture.business],
    );
    process.env['GATE_SIGNING_KEY_ID'] ??= fixture.environment.GATE_SIGNING_KEY_ID;
    process.env['GATE_SIGNING_SECRET'] ??= fixture.environment.GATE_SIGNING_SECRET;
    bravo = await seedSchedules(fixture.db, 'owner_plan_bravo', 1_000_000);
    await holdsRole(fixture.db, bravo.business, bravo.decider.personId, 'owner');
    custody = await openCustodyWorld();
  }, 180_000);

  afterAll(async () => {
    await custody?.close();
    await fixture?.db.drop();
  });

  it("picks up the owner's accepted plan on its delegation's task, and the run is carried on the owner's plan", async () => {
    const { taskId, revision, credential } = await ownersTask();
    const reservationId = await acceptedPlan(ownerToken, taskId, revision);
    const pickups: Pickup[] = [];
    const worker = workerOn(callingOn([PLAN_ROUTE], taskId, pickups), credential);

    const outcome = await worker.applyOnce(taskId);

    expect(outcome, JSON.stringify(outcome)).toHaveProperty('handedBack');
    expect(pickups).toHaveLength(1);
    expect(pickups[0]?.calls).toEqual([expect.objectContaining({ ok: true })]);
    expect(await callsOn(pickups[0]?.detail['leaseId'])).toEqual([
      {
        state: 'settled',
        route_key: 'chatgpt_plan',
        credential_kind: 'subscription',
        refusal_code: null,
      },
    ]);
    expect((await reservation(reservationId))?.lease_id).toEqual(expect.any(String));
  }, 120_000);

  /** The worker's own step proposed on a fresh task of the owner's, and accepted by the owner. */
  async function ownProposalAccepted() {
    const { taskId, credential } = await ownersTask();
    const proposed = await workerOn(transport, credential).proposeOnce();
    if (!('proposed' in proposed)) throw new Error(`propose: ${JSON.stringify(proposed)}`);
    const [gate] = await fixture.db.admin.execute<{ version_id: string }>(
      'select version_id::text from public.gates where id = $1',
      [proposed.proposed.gateId],
    );
    await ownerAccepts({ gateId: proposed.proposed.gateId, versionId: gate?.version_id });
    return { taskId, credential };
  }

  it('its own proposal the owner accepted still runs as before, carried on a key', async () => {
    const { taskId, credential } = await ownProposalAccepted();
    const pickups: Pickup[] = [];
    const worker = workerOn(callingOn([API_ROUTE], taskId, pickups), credential);

    const outcome = await worker.applyOnce(taskId);

    expect(outcome, JSON.stringify(outcome)).toHaveProperty('handedBack');
    expect(pickups[0]?.calls).toEqual([expect.objectContaining({ ok: true })]);
    expect(await callsOn(pickups[0]?.detail['leaseId'])).toEqual([
      expect.objectContaining({
        state: 'settled',
        route_key: 'replay',
        credential_kind: 'api_key',
      }),
    ]);
  }, 120_000);

  // The plan's refusal is a definitive stop: it ends the attempt cancelled and
  // retires its lease and delegation (#1623 R1, B2), so no key carries it after.
  it("its own proposal is refused the owner's plan, and that ends its attempt cancelled", async () => {
    const { taskId, credential } = await ownProposalAccepted();
    const pickups: Pickup[] = [];
    const worker = workerOn(callingOn([PLAN_ROUTE, API_ROUTE], taskId, pickups), credential);

    const outcome = await worker.applyOnce(taskId);

    expect(outcome, JSON.stringify(outcome)).toEqual({
      refused: { code: 'DELEGATION_NOT_LIVE', names: [] },
    });
    expect(pickups).toHaveLength(1);
    expect(pickups[0]?.calls, JSON.stringify(pickups[0]?.calls)).toEqual([
      expect.objectContaining({ ok: false, code: 'SUBSCRIPTION_NOT_OWNER_STARTED' }),
      expect.objectContaining({ ok: false }),
    ]);
    expect(await callsOn(pickups[0]?.detail['leaseId'])).toEqual([
      expect.objectContaining({ state: 'refused', refusal_code: 'SUBSCRIPTION_NOT_OWNER_STARTED' }),
    ]);
    const { attemptId } = await attemptOfLease(
      fixture.db.admin,
      fixture.business,
      String(pickups[0]?.detail['leaseId']),
    );
    expect(await outcomesOfAttempt(fixture.db.admin, fixture.business, attemptId)).toEqual([
      expect.objectContaining({ outcome: 'cancelled', end_code: 'SUBSCRIPTION_NOT_OWNER_STARTED' }),
    ]);
  }, 120_000);

  it("leaves a member's proposal the owner accepted on its task queued", async () => {
    const { taskId, revision, credential } = await ownersTask();
    const reservationId = await acceptedPlan(staffToken, taskId, revision);
    const pickups: Pickup[] = [];

    expect(
      await workerOn(callingOn([PLAN_ROUTE], taskId, pickups), credential).applyOnce(taskId),
    ).toStrictEqual({
      idle: { taskId },
    });
    expect(pickups).toEqual([]);
    expect(await reservation(reservationId)).toStrictEqual({ state: 'held', lease_id: null });
  }, 120_000);

  it("leaves the owner's accepted plan on another delegation's task queued, the same agent holding both", async () => {
    const mine = await ownersTask();
    const theirs = await ownersTask();
    const reservationId = await acceptedPlan(ownerToken, theirs.taskId, theirs.revision);
    const pickups: Pickup[] = [];
    const worker = workerOn(callingOn([PLAN_ROUTE], theirs.taskId, pickups), mine.credential);

    expect(await worker.applyOnce(theirs.taskId)).toStrictEqual({
      idle: { taskId: theirs.taskId },
    });
    expect(await worker.applyOnce(mine.taskId)).toStrictEqual({ idle: { taskId: mine.taskId } });
    expect(pickups).toEqual([]);
    expect(await reservation(reservationId)).toStrictEqual({ state: 'held', lease_id: null });
  }, 120_000);

  it("leaves another business's owner-accepted plan queued", async () => {
    const { credential } = await ownersTask();
    const bravoTask = await createBravoTask(bravo, `bravo canary ${randomUUID()}`);
    const decision = await approveInBravo(
      bravo,
      await proposeInBravo(bravo, bravoTask, { purpose: SYNTHETIC_STEP.kind }),
    );
    const pickups: Pickup[] = [];

    expect(
      await workerOn(callingOn([PLAN_ROUTE], bravoTask, pickups), credential).applyOnce(bravoTask),
    ).toStrictEqual({ idle: { taskId: bravoTask } });
    expect(pickups).toEqual([]);
    expect(await reservation(String(decision['reservationId']))).toStrictEqual({
      state: 'held',
      lease_id: null,
    });
  }, 120_000);

  it('picks up nothing once its delegation is revoked, though the worker had already read its identity', async () => {
    const { taskId, revision, credential, delegationId } = await ownersTask();
    const pickups: Pickup[] = [];
    const worker = workerOn(callingOn([PLAN_ROUTE], taskId, pickups), credential);
    expect(await worker.applyOnce(taskId)).toStrictEqual({ idle: { taskId } });
    const reservationId = await acceptedPlan(ownerToken, taskId, revision);
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      expect(await revokeDelegation(tx, delegationId)).toBeInstanceOf(Date);
    });

    const outcome = await worker.applyOnce(taskId);

    expect(outcome, JSON.stringify(outcome)).toHaveProperty('refused');
    expect(pickups).toEqual([]);
    expect(await reservation(reservationId)).toStrictEqual({ state: 'held', lease_id: null });
  }, 120_000);

  // Review S2113-1 and S2113-2's proofs and its check of the queue flag, assertions as given.
  it('a revocation committed after the worker read its delegation, before the pickup, claims nothing and calls no model', async () => {
    const { taskId, revision, credential, delegationId } = await ownersTask();
    const reservationId = await acceptedPlan(ownerToken, taskId, revision);
    const pickups: Pickup[] = [];
    let revoked = false;
    const through = callingOn([PLAN_ROUTE], taskId, pickups);
    const revokeBeforePickup: Transport = async (path, body, bearer, delegation) => {
      if (path.endsWith('/task/pickup') && !revoked) {
        revoked = true;
        await fixture.db.app.withBusiness(fixture.business, async (tx) => {
          expect(await revokeDelegation(tx, delegationId)).toBeInstanceOf(Date);
        });
      }
      return await through(path, body, bearer, delegation);
    };
    const outcome = await workerOn(revokeBeforePickup, credential).applyOnce(taskId);
    expect({
      outcome,
      pickupCount: pickups.length,
      calls: pickups.flatMap((p) => p.calls).map((c) => c.ok),
      reservation: await reservation(reservationId),
    }).toMatchObject({
      pickupCount: 0,
      calls: [],
      reservation: { state: 'held', lease_id: null },
    });
  }, 120_000);

  it('owner-proposed work a member approved stays queued', async () => {
    const { taskId, revision, credential } = await ownersTask();
    const proposed = detailOf(
      await as(ownerToken, 'task.propose', {
        operationId: randomUUID(),
        recordId: taskId,
        expectedRevision: revision,
        purpose: SYNTHETIC_STEP.kind,
        maximumMinor: 2_500,
        currency: 'AUD',
        payload: { change: 'update the About page hours' },
        step: SYNTHETIC_STEP,
      }),
    );
    // The immutable proposal stamp is owner's; the approving person no longer is.
    await holdsRole(fixture.db, fixture.business, fixture.member.personId, 'member');
    const reservationId = await ownerAccepts(proposed);
    const [stamp] = await fixture.db.admin.execute<{ proposed: boolean; approved: boolean }>(
      `select v.proposed_by_owner as proposed, d.decided_by_owner as approved
       from public.proposal_versions v join public.gate_decisions d
         on d.business_id = v.business_id and d.version_id = v.id
       where v.business_id = $1 and v.id = $2 and d.decision = 'approve'`,
      [fixture.business, proposed['versionId']],
    );
    expect(stamp).toEqual({ proposed: true, approved: false });
    await holdsRole(fixture.db, fixture.business, fixture.member.personId, 'owner');
    const pickups: Pickup[] = [];
    const outcome = await workerOn(callingOn([PLAN_ROUTE], taskId, pickups), credential).applyOnce(
      taskId,
    );
    expect({
      outcome,
      pickupCount: pickups.length,
      calls: pickups.flatMap((p) => p.calls).map((c) => (c.ok ? 'carried' : c.code)),
      reservation: await reservation(reservationId),
    }).toMatchObject({
      outcome: { idle: { taskId } },
      calls: [],
      pickupCount: 0,
      reservation: { state: 'held', lease_id: null },
    });
  }, 120_000);

  it('the queue says the owner proposed it, as a role, never naming the proposer', async () => {
    const { taskId, revision } = await ownersTask();
    const reservationId = await acceptedPlan(ownerToken, taskId, revision);
    const response = await transport(
      `/api/a/b/${BUSINESS_KEY}${pathOf('task.queue')}`,
      JSON.stringify({ operationId: randomUUID() }),
      agentToken,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { detail: { queue: Record<string, unknown>[] } };
    const row = body.detail.queue.find((q) => q['reservationId'] === reservationId);
    expect(row).toMatchObject({ taskId, ownerProposed: true, proposedByActorId: null });
    expect(Object.keys(row ?? {}).toSorted()).toEqual(
      [
        'heldMinor',
        'lineageId',
        'ownerProposed',
        'proposedByActorId',
        'purpose',
        'reservationId',
        'runId',
        'taskId',
        'versionId',
      ].toSorted(),
    );
    expect(JSON.stringify(row)).not.toContain(fixture.member.actorId);
    expect(JSON.stringify(row)).not.toContain(fixture.member.personId);
  }, 120_000);

  // Review S2113's round two: a pickup's delegation, its own and its parent's, assertions as given.
  it("a pickup under one delegation cannot claim another delegation's task, and its minted authority rolls back", async () => {
    const mine = await ownersTask();
    const theirs = await ownersTask();
    const reservationId = await acceptedPlan(ownerToken, theirs.taskId, theirs.revision);
    const before = await fixture.db.admin.execute<{ id: string }>(
      'select id from public.delegations where business_id = $1',
      [fixture.business],
    );
    const response = await transport(
      `/api/a/b/${BUSINESS_KEY}${pathOf('task.pickup')}`,
      JSON.stringify({ operationId: randomUUID(), reservationId }),
      agentToken,
      mine.credential,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'DELEGATION_OUT_OF_PURPOSE' });
    expect(await reservation(reservationId)).toStrictEqual({ state: 'held', lease_id: null });
    const after = await fixture.db.admin.execute<{ id: string }>(
      'select id from public.delegations where business_id = $1',
      [fixture.business],
    );
    expect(after.map((r) => r.id).toSorted()).toEqual(before.map((r) => r.id).toSorted());
  }, 120_000);

  it('a worker whose delegation was revoked after it cached its identity cannot pick up its own accepted proposal', async () => {
    const { taskId, credential, delegationId } = await ownersTask();
    const pickups: Pickup[] = [];
    const worker = workerOn(callingOn([PLAN_ROUTE], taskId, pickups), credential);
    const proposal = await worker.proposeOnce();
    if (!('proposed' in proposal)) throw new Error('proposal refused');
    const [gate] = await fixture.db.admin.execute<{ version_id: string }>(
      'select version_id::text from public.gates where id = $1',
      [proposal.proposed.gateId],
    );
    const reservationId = await ownerAccepts({
      gateId: proposal.proposed.gateId,
      versionId: gate?.version_id,
    });
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await revokeDelegation(tx, delegationId);
    });
    expect(await worker.applyOnce(taskId)).toMatchObject({
      refused: { code: 'DELEGATION_NOT_LIVE' },
    });
    expect(pickups).toEqual([]);
    expect(await reservation(reservationId)).toStrictEqual({ state: 'held', lease_id: null });
  }, 120_000);

  // eslint-disable-next-line max-lines-per-function -- the helper's chain is minted inline, as the review wrote it
  it("a helper whose parent delegation is revoked after the helper's task read claims nothing and calls no model", async () => {
    const { taskId, revision } = await ownersTask();
    const reservationId = await acceptedPlan(ownerToken, taskId, revision);
    const { parentId, credential } = await fixture.db.app.withBusiness(
      fixture.business,
      async (tx) => {
        await grantTo(tx, fixture.member, 'write', { kind: 'business', id: null }, false, 'run');
        const parentActor = randomUUID();
        await tx.query(
          `insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`,
          [fixture.business, parentActor],
        );
        const parent = await mintDelegation(tx, {
          agentActorId: parentActor,
          delegatePersonId: fixture.member.personId,
          mintedByActorId: fixture.member.actorId,
          purpose: `parent_${randomUUID().slice(0, 8)}`,
          collections: ['task', 'run'],
          actions: ['read', 'comment', 'write'],
          purposeScope: { kind: 'record', id: taskId },
          expiresAt: new Date(Date.now() + 3_600_000),
        });
        if (!parent.ok) throw new Error(parent.refusal.code);
        const child = await mintChildDelegation(tx, parent.value.delegation, {
          agentActorId: fixture.agentActorId,
          purpose: `helper_${randomUUID().slice(0, 8)}`,
          collections: ['task'],
          actions: ['read', 'comment', 'write'],
          expiresAt: new Date(Date.now() + 1_800_000),
        });
        if (!child.ok) throw new Error(child.refusal.code);
        return { parentId: parent.value.delegation.id, credential: child.value.credential };
      },
    );
    const pickups: Pickup[] = [];
    const through = callingOn([PLAN_ROUTE], taskId, pickups);
    let revoked = false;
    const revokeBeforePickup: Transport = async (path, body, bearer, delegation) => {
      if (path.endsWith('/task/pickup') && !revoked) {
        revoked = true;
        await fixture.db.app.withBusiness(fixture.business, async (tx) => {
          expect(await revokeDelegation(tx, parentId)).toBeInstanceOf(Date);
        });
      }
      return await through(path, body, bearer, delegation);
    };
    const outcome = await workerOn(revokeBeforePickup, credential).applyOnce(taskId);
    expect({
      outcome,
      pickupCount: pickups.length,
      calls: pickups.flatMap((p) => p.calls).map((c) => c.ok),
      reservation: await reservation(reservationId),
    }).toMatchObject({
      pickupCount: 0,
      calls: [],
      reservation: { state: 'held', lease_id: null },
    });
  }, 120_000);
});
