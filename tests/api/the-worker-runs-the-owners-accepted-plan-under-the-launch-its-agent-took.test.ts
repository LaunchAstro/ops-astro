// SPDX-License-Identifier: AGPL-3.0-only
//
// BRIDGE1705 (#1705 item 6): production mints no delegation for the worker
// on the owner's task except Launch's. So the owner proposes and approves the
// worker's step on his own task, then assigns the agent and launches; the
// agent, signed in as itself, takes the launch and is handed the run's
// credential; the worker, holding that credential as its delegation, picks
// up the owner's accepted plan on that task and runs it on the owner's plan
// to a recorded end. Nothing here mints a delegation by hand.

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
import { pathOf, PREFIX } from '../../packages/core-wire/src/index.ts';
import { readIdentity } from '../../apps/api/identity.ts';
import type { Transport } from '../../apps/cli/client.ts';
import { createWorker, SYNTHETIC_STEP } from '../../apps/worker/worker.ts';
import { SYNTHETIC_USAGE } from '../../apps/worker/usage.ts';
import { openCustodyWorld, type CustodyWorld } from '../custody/custody-world.ts';
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
const ROOT = resolve(import.meta.dirname, '../..');

if (serverUrl === undefined) {
  console.warn(
    'api/the-worker-runs-the-owners-accepted-plan-under-the-launch-its-agent-took: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Name = Parameters<typeof pathOf>[0];

const PLAN_COMPOSE = {
  ...REPLAY_COMPOSE,
  key: 'model.plan_compose',
  provider: CHATGPT_PLAN_PROVIDER,
};

const PLAN_ROUTE: BrokerRoute = {
  key: 'chatgpt_plan',
  reach: 'cloud',
  provider: CHATGPT_PLAN_PROVIDER,
  credentialRef: 'replay_key',
  credentialKind: 'subscription',
  installation: 'here',
  ceiling: 1_000,
};

const detailOf = (answer: Answer): Record<string, unknown> => {
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body['detail'] as Record<string, unknown>;
};

// eslint-disable-next-line max-lines-per-function -- one served API and broker
describe.skipIf(serverUrl === undefined)('the worker under a taken launch', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let custody: CustodyWorld;
  let ownerToken: string;
  let agentToken: string;

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
    await post(api, `${PREFIX.person}${BUSINESS_KEY}${pathOf(name)}`, body, authorised(token));

  const asAgent = async (name: Name, body: object): Promise<Answer> =>
    await post(api, `${PREFIX.agent}${BUSINESS_KEY}${pathOf(name)}`, body, authorised(agentToken));

  const revisionOf = async (taskId: string): Promise<number> => {
    const rows = await fixture.db.admin.execute<{ readonly revision: string }>(
      'select revision::text as revision from public.records where id = $1',
      [taskId],
    );
    return Number(rows[0]?.revision ?? '0');
  };

  const broker: () => Broker = () => ({
    custody: custody.custody,
    operations: catalogue([PLAN_COMPOSE]),
    providers: new Map([[CHATGPT_PLAN_PROVIDER, { build: replayAdapter, price: replayCostMinor }]]),
    routes: [PLAN_ROUTE],
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

  beforeAll(async () => {
    fixture = await createApiFixture('worker_taken_launch');
    api = fixture.compose(undefined, readIdentity(ROOT));
    await fixture.db.admin.execute(
      `update public.memberships set active = false, ended_at = clock_timestamp()
        where business_id = $1 and person_id = $2 and active`,
      [fixture.business, fixture.member.personId],
    );
    await fixture.db.admin.execute(
      `insert into public.memberships (business_id, id, person_id, role_key, active, joined_at)
       values ($1, $2, $3, 'owner', true, clock_timestamp())`,
      [fixture.business, randomUUID(), fixture.member.personId],
    );
    // His own agent, as "Make my agent" leaves it: only an agent he owns may be handed his task.
    await fixture.db.admin.execute(
      'update public.actors set owner_person_id = $2 where business_id = $1 and id = $3',
      [fixture.business, fixture.member.personId, fixture.agentActorId],
    );
    await fixture.db.admin.execute(
      'update public.budget_caps set limit_minor = 1000000000 where business_id = $1',
      [fixture.business],
    );
    ownerToken = await tokenFor(fixture.member.presented.subject);
    agentToken = await tokenFor(fixture.agent.subject);
    process.env['GATE_SIGNING_KEY_ID'] ??= fixture.environment.GATE_SIGNING_KEY_ID;
    process.env['GATE_SIGNING_SECRET'] ??= fixture.environment.GATE_SIGNING_SECRET;
    custody = await openCustodyWorld();
  }, 180_000);

  afterAll(async () => {
    await custody?.close();
    await fixture?.db.drop();
  });

  // eslint-disable-next-line max-lines-per-function -- one run from the owner's plan to its end
  it("picks up the owner's accepted plan under the launch its agent took, and the run is carried on the owner's plan to an end", async () => {
    // The owner's own task, his proposal, his approval: before the agent holds it.
    const created = await as(ownerToken, 'task.create', {
      operationId: randomUUID(),
      fields: { title: `Item 6 test ${randomUUID()}` },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const taskId = String(created.body['recordId']);
    const proposed = detailOf(
      await as(ownerToken, 'task.propose', {
        operationId: randomUUID(),
        recordId: taskId,
        expectedRevision: await revisionOf(taskId),
        purpose: SYNTHETIC_STEP.kind,
        maximumMinor: 2_500,
        currency: 'AUD',
        payload: {},
        step: SYNTHETIC_STEP,
      }),
    );
    detailOf(
      await as(ownerToken, 'task.decide', {
        operationId: randomUUID(),
        gateId: proposed['gateId'],
        versionId: proposed['versionId'],
        decision: 'approve',
        note: 'go ahead',
      }),
    );

    // Then he hands it to the agent and launches it, and the agent takes the launch.
    const assigned = await as(ownerToken, 'task.assign', {
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(taskId),
      fields: { agent: fixture.agentActorId },
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    const launched = await as(ownerToken, 'task.launch', {
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(taskId),
    });
    expect(launched.status, JSON.stringify(launched.body)).toBe(200);
    const taken = detailOf(await asAgent('task.take_launch', { operationId: randomUUID() }));
    expect(taken['state']).toBe('started');
    const credential = String(taken['credential']);

    // The worker, on that credential, runs the owner's plan; the run's call goes to the plan route.
    const calls: ModelCallResult[] = [];
    let held: Record<string, unknown> | undefined;
    const through: Transport = async (path, body, bearer, delegation) => {
      if (path.endsWith('/task/dispatch') && held !== undefined) {
        const leaseId = String(held['leaseId']);
        const [step] = await fixture.db.admin.execute<{ id: string }>(
          `select st.id::text from public.planned_steps st join public.leases l on l.run_id = st.run_id
            where l.id = $1 order by st.ordinal limit 1`,
          [leaseId],
        );
        calls.push(
          await callModel(
            fixture.db.app,
            fixture.business,
            {
              actorId: fixture.agentActorId,
              delegationId: String(held['delegationId']),
              attendedByPersonId: null,
            },
            {
              leaseId,
              fence: Number(held['fence']),
              stepId: String(step?.id),
              operation: PLAN_COMPOSE.key,
              fields: [{ name: 'instruction', from: { recordId: taskId, key: 'title' } }],
            },
            broker(),
          ),
        );
      }
      const response = await transport(path, body, bearer, delegation);
      if (path.endsWith('/task/pickup') && response.status === 200) {
        held = ((await response.clone().json()) as { detail: Record<string, unknown> }).detail;
      }
      return response;
    };
    const worker = createWorker({
      transport: through,
      businessKey: BUSINESS_KEY,
      credential: agentToken,
      delegation: credential,
      reporter: SYNTHETIC_USAGE,
      // Passed explicitly: nothing to compute, so the plan goes straight to review.
      runner: {
        compute: async () => await Promise.resolve({ outcome: 'success', endCode: 'COMPLETED' }),
      },
    });

    const outcome = await worker.applyOnce(taskId);

    expect(outcome, JSON.stringify(outcome)).toHaveProperty('handedBack');
    expect(calls, JSON.stringify(calls)).toEqual([expect.objectContaining({ ok: true })]);
    const recorded = await fixture.db.admin.execute<Record<string, unknown>>(
      `select state, route_key, credential_kind from public.model_calls where lease_id = $1`,
      [held?.['leaseId']],
    );
    expect(recorded).toEqual([
      { state: 'settled', route_key: 'chatgpt_plan', credential_kind: 'subscription' },
    ]);
  }, 180_000);
});
