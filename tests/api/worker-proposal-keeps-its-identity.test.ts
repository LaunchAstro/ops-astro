// SPDX-License-Identifier: AGPL-3.0-only
//
// A worker's committed proposal keeps its operation identity until an answer
// proves where it stands. A replay refused because the delegating person's
// write grant lapsed withholds a committed receipt rather than proving the
// proposal never happened, so once the grant is back the worker recovers the
// first gate. Two proposal passes started together on one worker share one
// proposal, so the second cannot replace the first's identity with its own.
// The worker runs against the served API over a real database; only the
// answers named in each case are held or replaced.

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { readIdentity } from '../../apps/api/identity.ts';
import type { Transport } from '../../apps/cli/client.ts';
import { createWorker } from '../../apps/worker/worker.ts';
import { SYNTHETIC_USAGE } from '../../apps/worker/usage.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type ApiFixture,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
const ROOT = resolve(import.meta.dirname, '../..');

if (serverUrl === undefined) {
  console.warn(
    'api/worker-proposal-keeps-its-identity: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

/** The answer a proxy gives when the API's own answer is lost. */
const lost = (): Response =>
  new Response(JSON.stringify({ code: 'UPSTREAM_UNAVAILABLE' }), { status: 503 });

// eslint-disable-next-line max-lines-per-function -- one served API, both cases on it
describe.skipIf(serverUrl === undefined)('a worker proposal keeps its identity', () => {
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

  /** The first task.propose reaches the API and commits; its answer is replaced by a 503. */
  const losingFirstPropose = (): Transport => {
    let lose = true;
    return async (path, body, bearer, delegation) => {
      const response = await transport(path, body, bearer, delegation);
      if (!lose || !path.endsWith('/task/propose')) return response;
      lose = false;
      expect(response.status).toBe(200);
      return lost();
    };
  };

  const workerOn = (through: Transport, delegation: string) =>
    createWorker({
      transport: through,
      businessKey: BUSINESS_KEY,
      credential: agentToken,
      delegation,
      reporter: SYNTHETIC_USAGE,
    });

  /** A new task and the agent's read, comment and write delegation scoped to it. */
  async function delegatedTask() {
    const created = await post(
      api,
      `/api/b/${BUSINESS_KEY}${pathOf('task.create')}`,
      { operationId: randomUUID(), fields: { title: `identity ${randomUUID()}` } },
      authorised(personToken),
    );
    const taskId = String(created.body['recordId']);
    const credential = await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      const minted = await mintDelegation(tx, {
        agentActorId: fixture.agentActorId,
        delegatePersonId: fixture.member.personId,
        mintedByActorId: fixture.member.actorId,
        purpose: `identity_${randomUUID().slice(0, 8)}`,
        collections: ['task'],
        actions: ['read', 'comment', 'write'],
        purposeScope: { kind: 'record', id: taskId },
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
      return minted.value.credential;
    });
    return { taskId, credential };
  }

  /** The task's lineages, each with its gates; fails unless there is exactly one lineage. */
  async function gatesOfOnlyLineage(taskId: string): Promise<string[]> {
    const lineages = await fixture.db.admin.execute<{ id: string }>(
      'select id::text from public.proposal_lineages where task_id = $1',
      [taskId],
    );
    expect(lineages).toHaveLength(1);
    const gates = await fixture.db.admin.execute<{ id: string }>(
      `select g.id::text from public.gates g
         join public.proposal_versions v on v.business_id = g.business_id and v.id = g.version_id
        where v.lineage_id = $1`,
      [lineages[0]?.id],
    );
    return gates.map((gate) => gate.id);
  }

  /** The person's task write grants: expired at once, or given back. */
  const writeGrants = async (expired: boolean): Promise<void> => {
    await fixture.db.admin.execute(
      `update public.grants
          set expires_at = case when $3 then clock_timestamp() - interval '1 second' end
        where business_id = $1 and subject_kind = 'person' and subject_id = $2
          and collection = 'task' and action = 'write' and revoked_at is null`,
      [fixture.business, fixture.member.personId, expired],
    );
  };

  beforeAll(async () => {
    fixture = await createApiFixture('worker_identity');
    api = fixture.compose(undefined, readIdentity(ROOT));
    personToken = await tokenFor(fixture.member.presented.subject);
    agentToken = await tokenFor(fixture.agent.subject);
  }, 120_000);

  afterAll(async () => {
    await fixture?.db.drop();
  });

  it("a replay refused while the person's write grant has lapsed keeps the committed proposal: once it is back, the worker recovers the first gate", async () => {
    const { taskId, credential } = await delegatedTask();
    const worker = workerOn(losingFirstPropose(), credential);
    expect(await worker.proposeOnce()).toStrictEqual({ fault: { status: 503 } });
    await writeGrants(true);
    try {
      expect(await worker.proposeOnce()).toMatchObject({
        refused: { code: 'DELEGATION_NARROWED' },
      });
    } finally {
      await writeGrants(false);
    }
    const recovered = await worker.proposeOnce();
    if (!('proposed' in recovered)) throw new Error(`propose: ${JSON.stringify(recovered)}`);
    expect(await gatesOfOnlyLineage(taskId)).toStrictEqual([recovered.proposed.gateId]);
  });

  it('two proposal passes started together on one worker leave one lineage and one gate', async () => {
    const { taskId, credential } = await delegatedTask();
    // Each successful task.read answer is held, after it reached the API, until released.
    const heldReads: (() => void)[] = [];
    const holding = losingFirstPropose();
    const through: Transport = async (path, body, bearer, delegation) => {
      const response = await holding(path, body, bearer, delegation);
      if (!path.endsWith('/task/read')) return response;
      expect(response.status).toBe(200);
      await new Promise<void>((release) => {
        heldReads.push(release);
      });
      return response;
    };
    const worker = workerOn(through, credential);
    const first = worker.proposeOnce();
    const second = worker.proposeOnce();
    await expect.poll(() => heldReads.length).toBeGreaterThan(0);
    // Room for the second pass's read to reach the API too, if it sends one.
    await new Promise((settle) => {
      setTimeout(settle, 500);
    });
    // A's read answers; its proposal commits and the answer is lost.
    heldReads.shift()?.();
    expect(await first).toStrictEqual({ fault: { status: 503 } });
    // Then B's read answers, when B sent one.
    heldReads.shift()?.();
    await second;
    expect(await gatesOfOnlyLineage(taskId)).toHaveLength(1);
  });
});
