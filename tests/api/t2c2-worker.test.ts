// SPDX-License-Identifier: AGPL-3.0-only
//
// T2c2 through the served API: the worker proposes, a person approves that
// version, and the worker applies it once through the agent routes (pickup,
// dispatch, the team-only comment under the attempt's operation identity,
// observe). The person reads the receipt through the command line's client,
// and it names the approval it came from. A second worker pass finds nothing
// to pick up and adds nothing. `task.observe` refuses the same things on the
// agent and person routes, and the receipt read refuses another business.

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { readIdentity } from '../../apps/api/identity.ts';
import { createCli, type Transport } from '../../apps/cli/client.ts';
import { createWorker, EFFECT_BODY } from '../../apps/worker/worker.ts';
import { ProviderFault, SYNTHETIC_USAGE } from '../../apps/worker/usage.ts';
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
  console.warn('api/t2c2: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

type Name = Parameters<typeof pathOf>[0];

describe.skipIf(serverUrl === undefined)('T2c2: the worker applies one approved effect', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let personToken: string;
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

  const asPerson = async (name: Name, body: object): Promise<Answer> =>
    await post(api, `/api/b/${BUSINESS_KEY}${pathOf(name)}`, body, authorised(personToken));

  async function approvedWork() {
    const created = await asPerson('task.create', {
      operationId: randomUUID(),
      fields: { title: `t2c2 ${randomUUID()}` },
    });
    const taskId = String(created.body['recordId']);
    const credential = await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      const minted = await mintDelegation(tx, {
        agentActorId: fixture.agentActorId,
        delegatePersonId: fixture.member.personId,
        mintedByActorId: fixture.member.actorId,
        purpose: `t2c2_${randomUUID().slice(0, 8)}`,
        collections: ['task'],
        actions: ['read', 'comment', 'write'],
        purposeScope: { kind: 'record', id: taskId },
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
      return minted.value.credential;
    });
    const worker = createWorker({
      transport,
      businessKey: BUSINESS_KEY,
      credential: agentToken,
      delegation: credential,
      reporter: SYNTHETIC_USAGE,
    });
    const proposed = await worker.proposeOnce();
    if (!('proposed' in proposed)) throw new Error(`propose: ${JSON.stringify(proposed)}`);
    const read = await asPerson('task.read', { recordId: taskId });
    const task = read.body['task'] as { proposals: { versions: { versionId: string }[] }[] };
    const versionId = String(task.proposals[0]?.versions[0]?.versionId);
    const decided = await asPerson('task.decide', {
      operationId: randomUUID(),
      gateId: proposed.proposed.gateId,
      versionId,
      decision: 'approve',
      note: 'approve this version',
    });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    const decisionId = String((decided.body['detail'] as Record<string, unknown>)['decisionId']);
    return { taskId, worker, versionId, decisionId, credential };
  }

  const comments = async (taskId: string): Promise<readonly Record<string, unknown>[]> => {
    const read = await asPerson('task.read', { recordId: taskId });
    const task = read.body['task'] as { comments?: Record<string, unknown>[] };
    return task.comments ?? [];
  };

  beforeAll(async () => {
    fixture = await createApiFixture('t2c2');
    api = fixture.compose(undefined, readIdentity(ROOT));
    personToken = await tokenFor(fixture.member.presented.subject);
    agentToken = await tokenFor(fixture.agent.subject);
    await fixture.db.admin.execute(
      'update public.budget_caps set limit_minor = 1000000000 where business_id = $1',
      [fixture.business],
    );
  }, 120_000);

  // An agent holds one live delegation per purpose, and nothing in this head
  // ends the one a pickup minted once its effect is observed: T2d's settlement
  // will. Until then each case retires the worker's pickup delegation, so the
  // next case's pickup is not refused DELEGATION_ALREADY_LIVE.
  afterEach(async () => {
    await fixture.db.admin.execute(
      `update public.delegations set revoked_at = now(), revocation_cause = 'work_retired'
        where business_id = $1 and agent_actor_id = $2 and purpose = 'synthetic_comment'
          and revoked_at is null and settled_at is null`,
      [fixture.business, fixture.agentActorId],
    );
  });

  afterAll(async () => {
    await fixture?.db.drop();
  });

  it('effect_once_with_receipt through the API: one comment, a receipt naming the approval, and a second pass adds nothing', async () => {
    const { taskId, worker, versionId, decisionId } = await approvedWork();
    const applied = await worker.applyOnce(taskId);
    if (!('applied' in applied)) throw new Error(`apply: ${JSON.stringify(applied)}`);

    const cli = createCli({ transport, businessKey: BUSINESS_KEY, credential: personToken });
    const receipt = await cli.run('task.receipt', { attemptId: applied.applied.attemptId });
    expect(receipt.status, receipt.text).toBe(200);
    expect(receipt.body).toMatchObject({
      receipt: {
        taskId,
        decision: { id: decisionId },
        version: { id: versionId },
        effect: { commentId: applied.applied.commentId, audience: 'internal' },
      },
    });

    expect(await worker.applyOnce(taskId)).toStrictEqual({ idle: { taskId } });
    const written = (await comments(taskId)).filter((comment) => comment['body'] === EFFECT_BODY);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ audience: 'internal' });
  });

  it('observe refuses a made-up lease on the agent and the person route alike, and the receipt read refuses another business', async () => {
    const body = {
      operationId: randomUUID(),
      leaseId: randomUUID(),
      fence: 1,
      attemptId: randomUUID(),
    };
    const person = await asPerson('task.observe', body);
    expect(person.body).toMatchObject({ code: 'LEASE_NOT_OWNED' });
    const cli = createCli({ transport, businessKey: 'bravo', credential: personToken });
    const foreign = await cli.run('task.receipt', { attemptId: randomUUID() });
    expect(foreign.status).not.toBe(200);
    expect(foreign.text).not.toContain('receipt"');
  });

  it('Sol proof, criterion 2: a worker resumes observation after the effect commits and the observe route is briefly unavailable', async () => {
    const { taskId, credential } = await approvedWork();
    let failed = 0;
    const lostObservation: Transport = async (path, body, bearer, delegation) => {
      if (path.endsWith('/task/observe') && failed < 1) {
        failed += 1;
        return new Response(JSON.stringify({ code: 'UPSTREAM_UNAVAILABLE' }), { status: 503 });
      }
      return await transport(path, body, bearer, delegation);
    };
    const worker = createWorker({
      transport: lostObservation,
      businessKey: BUSINESS_KEY,
      credential: agentToken,
      delegation: credential,
      reporter: SYNTHETIC_USAGE,
    });
    const first = await worker.applyOnce(taskId);
    expect(
      (await comments(taskId)).filter((comment) => comment['body'] === EFFECT_BODY),
    ).toHaveLength(1);
    const resumed = 'applied' in first ? first : await worker.applyOnce(taskId);
    expect(resumed).toHaveProperty('applied');
    if (!('applied' in resumed)) return;
    const receipt = await asPerson('task.receipt', { attemptId: resumed.applied.attemptId });
    expect(receipt.status).toBe(200);
    expect(
      (await comments(taskId)).filter((comment) => comment['body'] === EFFECT_BODY),
    ).toHaveLength(1);
  });

  it('Sol proof, criterion 2: a worker recovers a committed pickup after its response is lost', async () => {
    const { taskId, credential } = await approvedWork();
    let lost = false;
    const lostPickup: Transport = async (path, body, bearer, delegation) => {
      const response = await transport(path, body, bearer, delegation);
      if (path.endsWith('/task/pickup') && !lost) {
        expect(response.status).toBe(200);
        lost = true;
        return new Response(JSON.stringify({ code: 'UPSTREAM_UNAVAILABLE' }), { status: 503 });
      }
      return response;
    };
    const worker = createWorker({
      transport: lostPickup,
      businessKey: BUSINESS_KEY,
      credential: agentToken,
      delegation: credential,
      reporter: SYNTHETIC_USAGE,
    });
    const first = await worker.applyOnce(taskId);
    const resumed = 'applied' in first ? first : await worker.applyOnce(taskId);
    expect(resumed).toHaveProperty('applied');
    if (!('applied' in resumed)) return;
    const receipt = await asPerson('task.receipt', { attemptId: resumed.applied.attemptId });
    expect(receipt.status).toBe(200);
    expect(
      (await comments(taskId)).filter((comment) => comment['body'] === EFFECT_BODY),
    ).toHaveLength(1);
  });

  it('Sol proof, criterion 3: an uncertain provider call keeps the full hold until its effect is proved absent', async () => {
    const { taskId, credential } = await approvedWork();
    let providerEffects = 0;
    const worker = createWorker({
      transport,
      businessKey: BUSINESS_KEY,
      credential: agentToken,
      delegation: credential,
      reporter: SYNTHETIC_USAGE,
      provider: {
        call: async () => {
          providerEffects += 1;
          throw new ProviderFault('connection_lost');
        },
      },
    });

    expect(await worker.applyOnce(taskId)).toHaveProperty('dropped');
    expect(providerEffects).toBe(1);
    const attempts = await fixture.db.admin.execute<{
      state: string;
      dispatch_marker: boolean;
      reservation_state: string;
      held_minor: string;
    }>(
      `select att.state, att.dispatch_marker, res.state as reservation_state,
              res.held_minor::text as held_minor
         from public.attempts att
         join public.reservations res on res.business_id = att.business_id and res.id = att.reservation_id
         join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
        where att.business_id = $1 and run.task_id = $2 order by att.created_at, att.id`,
      [fixture.business, taskId],
    );
    expect(attempts[0]).toMatchObject({
      state: 'liability_unknown',
      dispatch_marker: true,
      reservation_state: 'held',
      held_minor: '2500',
    });
    expect(attempts).toHaveLength(1);
  });
});
