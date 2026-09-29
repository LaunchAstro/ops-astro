// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol review 1 on #154, criterion 3: the worker's money at each step when an
// answer is lost. The provider is called only once the step is marked, so a
// provider call that may have acted keeps the whole hold unknown and reserves
// nothing until the pass proves the effect absent. A lost answer at dispatch
// or at the effect replays and the effect happens once; a drop whose
// hand-back answer is lost is handed back again under its first identity and
// the provider is never called twice. A crash at each named point is the
// process proofs' (`drop-proofs.test.ts`, `runtime-proofs.test.tsx`); a lost
// pickup and a lost observation are T2c2's (`t2c2-worker.test.ts`).

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { reconcileUnknown } from '../../packages/core-runtime/src/index.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { grantTo } from '../commands/fixture.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { readIdentity } from '../../apps/api/identity.ts';
import { registerEffectLookup } from '../../apps/api/recovery-entry.ts';
import type { Transport } from '../../apps/cli/client.ts';
import { createWorker, EFFECT_BODY } from '../../apps/worker/worker.ts';
import { ProviderFault, SYNTHETIC_USAGE, type Provider } from '../../apps/worker/usage.ts';
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
type Name = Parameters<typeof pathOf>[0];

describe.skipIf(serverUrl === undefined)('T3e1: the worker at each step, answers lost', () => {
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

  /** Forwards every call, and loses the answer to the first `times` calls ending `suffix`. */
  const losing = (suffix: string, times: number): Transport => {
    let lost = 0;
    return async (path, body, bearer, delegation) => {
      const answer = await transport(path, body, bearer, delegation);
      if (path.endsWith(suffix) && lost < times) {
        lost += 1;
        return new Response(JSON.stringify({ code: 'UPSTREAM_UNAVAILABLE' }), { status: 503 });
      }
      return answer;
    };
  };

  const asPerson = async (name: Name, body: object): Promise<Answer> =>
    await post(api, `/api/b/${BUSINESS_KEY}${pathOf(name)}`, body, authorised(personToken));

  async function approvedWork() {
    const created = await asPerson('task.create', {
      operationId: randomUUID(),
      fields: { title: `t3e1 steps ${randomUUID()}` },
    });
    const taskId = String(created.body['recordId']);
    const credential = await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      const minted = await mintDelegation(tx, {
        agentActorId: fixture.agentActorId,
        delegatePersonId: fixture.member.personId,
        mintedByActorId: fixture.member.actorId,
        purpose: `t3e1s_${randomUUID().slice(0, 8)}`,
        collections: ['task'],
        actions: ['read', 'comment', 'write'],
        purposeScope: { kind: 'record', id: taskId },
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
      return minted.value.credential;
    });
    const proposer = createWorker({
      transport,
      businessKey: BUSINESS_KEY,
      credential: agentToken,
      delegation: credential,
      reporter: SYNTHETIC_USAGE,
    });
    const proposed = await proposer.proposeOnce();
    if (!('proposed' in proposed)) throw new Error(`propose: ${JSON.stringify(proposed)}`);
    const read = await asPerson('task.read', { recordId: taskId });
    const task = read.body['task'] as { proposals: { versions: { versionId: string }[] }[] };
    const decided = await asPerson('task.decide', {
      operationId: randomUUID(),
      gateId: proposed.proposed.gateId,
      versionId: String(task.proposals[0]?.versions[0]?.versionId),
      decision: 'approve',
      note: 'approve this version',
    });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    return { taskId, credential };
  }

  const workerOn = (credential: string, through: Transport, provider?: Provider) =>
    createWorker({
      transport: through,
      businessKey: BUSINESS_KEY,
      credential: agentToken,
      delegation: credential,
      reporter: SYNTHETIC_USAGE,
      ...(provider === undefined ? {} : { provider }),
    });

  const effects = async (taskId: string): Promise<number> =>
    (
      await fixture.db.admin.execute(
        `select 1 from public.operations
          where business_id = $1 and record_id = $2 and command = 'task.comment'
            and outcome = 'applied' and operation_id like 'effect:%'`,
        [fixture.business, taskId],
      )
    ).length;

  const holds = async (taskId: string) =>
    await fixture.db.admin.execute<{
      state: string;
      marked: boolean;
      held: string;
      held_minor: string;
      drop_cause: string | null;
    }>(
      `select att.state, att.dispatch_marker as marked, res.state as held,
              res.held_minor::text as held_minor, att.drop_cause
         from public.attempts att
         join public.reservations res on res.business_id = att.business_id and res.id = att.reservation_id
         join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
        where att.business_id = $1 and run.task_id = $2 order by att.created_at, att.id`,
      [fixture.business, taskId],
    );

  /** The task's first attempt: the one a worker dropped. */
  const firstAttempt = async (taskId: string): Promise<string> =>
    String(
      (
        await fixture.db.admin.execute<{ id: string }>(
          `select att.id from public.attempts att
             join public.planned_runs run on run.business_id = att.business_id and run.id = att.run_id
            where att.business_id = $1 and run.task_id = $2 order by att.created_at, att.id limit 1`,
          [fixture.business, taskId],
        )
      )[0]?.id,
    );

  /** A person records one of the three outcomes on the dropped attempt (T3d1, O7). */
  const recordOutcome = async (taskId: string, outcome: string): Promise<void> => {
    const recorded = await asPerson('budget.record_outcome', {
      operationId: randomUUID(),
      recordId: taskId,
      attemptId: await firstAttempt(taskId),
      outcome,
    });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
  };

  beforeAll(async () => {
    fixture = await createApiFixture('t3e1s');
    api = fixture.compose(undefined, readIdentity(ROOT));
    personToken = await tokenFor(fixture.member.presented.subject);
    agentToken = await tokenFor(fixture.agent.subject);
    await fixture.db.admin.execute(
      'update public.budget_caps set limit_minor = 1000000000 where business_id = $1',
      [fixture.business],
    );
    // A person tops up room for a replacement beside the kept hold (T2e, O6),
    // with the four-eyes band above one hold, as T3d1's harness sets it.
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await installBusinessSettings(tx);
      await grantTo(tx, fixture.member, 'decide', undefined, false, 'billing');
    });
    await fixture.db.admin.execute(
      `update public.business_settings set value = '100000'::jsonb
        where business_id = $1 and key = 'four_eyes_threshold'`,
      [fixture.business],
    );
  }, 120_000);

  // One live delegation per purpose: each case retires the worker's pickup delegation.
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

  for (const [step, suffix] of [
    ['the dispatch mark', '/task/dispatch'],
    ['the effect', '/task/comment'],
  ] as const) {
    it(`an answer lost at ${step} replays, and the effect happens once`, async () => {
      const { taskId, credential } = await approvedWork();
      const worker = workerOn(credential, losing(suffix, 1));
      const first = await worker.applyOnce(taskId);
      const done = 'applied' in first ? first : await worker.applyOnce(taskId);
      expect(done).toHaveProperty('applied');
      expect(await effects(taskId)).toBe(1);
      expect(await holds(taskId)).toMatchObject([{ state: 'settled', held: 'actual' }]);
    });
  }

  it('a provider call that may have acted keeps the whole hold; its lost hand-back is sent again, never the call', async () => {
    const { taskId, credential } = await approvedWork();
    let calls = 0;
    const provider: Provider = {
      call: async () => {
        calls += 1;
        await Promise.resolve();
        throw new ProviderFault('connection_lost');
      },
    };
    const worker = workerOn(credential, losing('/task/handback', 2), provider);
    expect(await worker.applyOnce(taskId)).toHaveProperty('fault');
    expect(await worker.applyOnce(taskId)).toHaveProperty('fault');
    expect(await worker.applyOnce(taskId)).toStrictEqual({
      dropped: { taskId, cause: 'connection_lost' },
    });
    expect(calls).toBe(1);
    expect(await holds(taskId)).toMatchObject([
      {
        state: 'liability_unknown',
        marked: true,
        held: 'held',
        held_minor: '2500',
        drop_cause: 'connection_lost',
      },
    ]);
    expect(await effects(taskId)).toBe(0);
    // Nothing comes back on the worker's word.
    expect(await worker.applyOnce(taskId)).toStrictEqual({ idle: { taskId } });
    // A person closes it, so no unknown step is left for the cases after this.
    await recordOutcome(taskId, 'happened');
  });

  it("the pass cannot prove a provider drop absent; a person's nothing happened brings the work back, applied once", async () => {
    const { taskId, credential } = await approvedWork();
    const dropping = workerOn(credential, transport, {
      call: async () => {
        await Promise.resolve();
        throw new ProviderFault('provider_unavailable');
      },
    });
    expect(await dropping.applyOnce(taskId)).toHaveProperty('dropped');
    const attemptId = await firstAttempt(taskId);
    const answered = await fixture.db.app.withBusiness(
      fixture.business,
      async (tx) => await reconcileUnknown(tx, registerEffectLookup),
    );
    expect(answered).toContainEqual(expect.objectContaining({ attemptId, answer: 'unanswered' }));
    expect(await holds(taskId)).toMatchObject([
      { state: 'liability_unknown', held: 'held', held_minor: '2500' },
    ]);
    expect(await workerOn(credential, transport).applyOnce(taskId)).toStrictEqual({
      idle: { taskId },
    });

    await recordOutcome(taskId, 'nothing_happened');
    const again = await workerOn(credential, transport).applyOnce(taskId);
    expect(again).toHaveProperty('applied');
    expect(await effects(taskId)).toBe(1);
    // The person's word released the first hold; the replacement settled.
    expect(await holds(taskId)).toMatchObject([
      { state: 'abandoned', held: 'abandoned' },
      { state: 'settled', held: 'actual' },
    ]);
    const [run] = await fixture.db.admin.execute<{ reactivated: boolean }>(
      `select o.reactivated from public.outage_runs o
         join public.planned_runs r on r.business_id = o.business_id and r.id = o.run_id
        where o.business_id = $1 and r.task_id = $2`,
      [fixture.business, taskId],
    );
    expect(run).toMatchObject({ reactivated: true });
    const comments = await asPerson('task.read', { recordId: taskId });
    const written = (comments.body['task'] as { comments: { body: string }[] }).comments.filter(
      (comment) => comment.body === EFFECT_BODY,
    );
    expect(written).toHaveLength(1);
  });

  it('Sol proof, criterion 3: missing comment cannot prove an uncertain provider effect absent', async () => {
    const { taskId, credential } = await approvedWork();
    let providerEffects = 0;
    const provider: Provider = {
      call: async () => {
        providerEffects += 1;
        await Promise.resolve();
        throw new ProviderFault('connection_lost');
      },
    };
    expect(await workerOn(credential, transport, provider).applyOnce(taskId)).toHaveProperty(
      'dropped',
    );
    expect(providerEffects).toBe(1);
    expect(await effects(taskId)).toBe(0);
    const topUp = await asPerson('budget.top_up', {
      operationId: randomUUID(),
      recordId: taskId,
      amountMinor: 2_500,
      fromMaximumMinor: 2_500,
    });
    expect(topUp.status, JSON.stringify(topUp.body)).toBe(200);

    const answered = await fixture.db.app.withBusiness(
      fixture.business,
      async (tx) => await reconcileUnknown(tx, registerEffectLookup),
    );
    expect(answered).toMatchObject([{ answer: 'unanswered' }]);
    expect(await holds(taskId)).toMatchObject([
      { state: 'liability_unknown', held: 'held', held_minor: '2500' },
    ]);
  });
});
