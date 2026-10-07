// SPDX-License-Identifier: AGPL-3.0-only
//
// The worker's proposal is its own, by identity. A proposal that committed and
// lost its answer is asked again under the identity it was first sent with, so
// the next pass gets that lineage and gate back and opens no second one. Work
// another actor proposed on the worker's task stays in the queue: the worker
// picks up only a version it proposed, never one matched by task alone. The
// worker runs against the served API over a real database; only the answers
// named in each case are replaced.

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { readIdentity } from '../../apps/api/identity.ts';
import type { Transport } from '../../apps/cli/client.ts';
import { createWorker, SYNTHETIC_STEP } from '../../apps/worker/worker.ts';
import { SYNTHETIC_USAGE } from '../../apps/worker/usage.ts';
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
    'api/worker-works-only-its-own-proposal: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Name = Parameters<typeof pathOf>[0];

const detailOf = (answer: Answer): Record<string, unknown> => {
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body['detail'] as Record<string, unknown>;
};

// eslint-disable-next-line max-lines-per-function -- one served API, both cases on it
describe.skipIf(serverUrl === undefined)('the worker works only its own proposal', () => {
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

  const workerOn = (through: Transport, delegation: string) =>
    createWorker({
      transport: through,
      businessKey: BUSINESS_KEY,
      credential: agentToken,
      delegation,
      reporter: SYNTHETIC_USAGE,
    });

  /** A new task and the agent's delegation scoped to it, nothing proposed yet. */
  async function delegatedTask() {
    const created = await asPerson('task.create', {
      operationId: randomUUID(),
      fields: { title: `own proposal ${randomUUID()}` },
    });
    const taskId = String(created.body['recordId']);
    const credential = await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      const minted = await mintDelegation(tx, {
        agentActorId: fixture.agentActorId,
        delegatePersonId: fixture.member.personId,
        mintedByActorId: fixture.member.actorId,
        purpose: `own_${randomUUID().slice(0, 8)}`,
        collections: ['task'],
        actions: ['read', 'comment', 'write'],
        purposeScope: { kind: 'record', id: taskId },
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
      return minted.value.credential;
    });
    return { taskId, credential, revision: created.body['revision'] };
  }

  /** Each lineage on the task with its gates, as the database holds them. */
  const lineagesOf = async (taskId: string) =>
    await fixture.db.admin.execute<{ id: string; gates: string[] }>(
      `select lin.id::text,
              array(select g.id::text from public.gates g
                      join public.proposal_versions v on v.business_id = g.business_id
                                                     and v.id = g.version_id
                     where v.lineage_id = lin.id) as gates
         from public.proposal_lineages lin where lin.task_id = $1`,
      [taskId],
    );

  /** A person's own lineage of the worker's purpose on `taskId`, approved: queued work. */
  async function theirApprovedWork(taskId: string, revision: unknown) {
    const theirs = detailOf(
      await asPerson('task.propose', {
        operationId: randomUUID(),
        recordId: taskId,
        expectedRevision: revision,
        purpose: SYNTHETIC_STEP.kind,
        maximumMinor: 2_500,
        currency: 'AUD',
        payload: { change: 'the person proposed this one' },
        step: SYNTHETIC_STEP,
      }),
    );
    const decided = detailOf(
      await asPerson('task.decide', {
        operationId: randomUUID(),
        gateId: theirs['gateId'],
        versionId: theirs['versionId'],
        decision: 'approve',
        note: "approve the person's own proposal",
      }),
    );
    expect(theirs['lineageId']).toEqual(expect.any(String));
    expect(decided['reservationId']).toEqual(expect.any(String));
    return { lineageId: theirs['lineageId'], reservationId: decided['reservationId'] };
  }

  beforeAll(async () => {
    fixture = await createApiFixture('worker_own_proposal');
    api = fixture.compose(undefined, readIdentity(ROOT));
    personToken = await tokenFor(fixture.member.presented.subject);
    agentToken = await tokenFor(fixture.agent.subject);
    await fixture.db.admin.execute(
      'update public.budget_caps set limit_minor = 1000000000 where business_id = $1',
      [fixture.business],
    );
  }, 120_000);

  afterAll(async () => {
    await fixture?.db.drop();
  });

  it('a proposal that committed and lost its answer comes back on the next pass as its one lineage and gate', async () => {
    const { taskId, credential } = await delegatedTask();
    // The first task.propose reaches the API and commits; its answer is replaced by a 503.
    let lose = true;
    const losing: Transport = async (path, body, bearer, delegation) => {
      const response = await transport(path, body, bearer, delegation);
      if (!lose || !path.endsWith('/task/propose')) return response;
      lose = false;
      expect(response.status).toBe(200);
      return new Response(JSON.stringify({ code: 'UPSTREAM_UNAVAILABLE' }), { status: 503 });
    };
    const worker = workerOn(losing, credential);
    expect(await worker.proposeOnce()).toStrictEqual({ fault: { status: 503 } });
    const recovered = await worker.proposeOnce();
    if (!('proposed' in recovered)) throw new Error(`propose: ${JSON.stringify(recovered)}`);
    const lineages = await lineagesOf(taskId);
    expect(lineages).toHaveLength(1);
    expect(lineages[0]?.gates).toStrictEqual([recovered.proposed.gateId]);
  });

  it("a person's approved proposal on the worker's task stays queued: the worker picks up only a version it proposed", async () => {
    const { taskId, credential, revision } = await delegatedTask();
    // The worker's own lineage on the task, its gate still open.
    const worker = workerOn(transport, credential);
    const proposed = await worker.proposeOnce();
    if (!('proposed' in proposed)) throw new Error(`propose: ${JSON.stringify(proposed)}`);
    // A person's lineage of the same purpose on the same task, approved: the only queued work.
    const theirs = await theirApprovedWork(taskId, revision);
    const lineages = await lineagesOf(taskId);
    expect(lineages).toHaveLength(2);
    expect(lineages.map((one) => one.id)).toContain(theirs.lineageId);
    expect(lineages.flatMap((one) => one.gates)).toContain(proposed.proposed.gateId);

    // Neither this worker nor a fresh one under the same agent takes the person's work.
    expect(await worker.applyOnce(taskId)).toStrictEqual({ idle: { taskId } });
    expect(await workerOn(transport, credential).applyOnce(taskId)).toStrictEqual({
      idle: { taskId },
    });
    const [held] = await fixture.db.admin.execute<{ state: string; lease_id: string | null }>(
      'select state, lease_id::text from public.reservations where id = $1',
      [theirs.reservationId],
    );
    expect(held).toStrictEqual({ state: 'held', lease_id: null });
  });
});
