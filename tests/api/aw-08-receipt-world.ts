// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-08 (b)'s world through the real worker and API: one business, a person
// who launches, and the worker's agent under a delegation minted per task. The
// provider is injected as T3e1's cases inject it.

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, expect } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { readIdentity } from '../../apps/api/identity.ts';
import type { Transport } from '../../apps/cli/client.ts';
import { createWorker } from '../../apps/worker/worker.ts';
import { SYNTHETIC_USAGE, type Provider } from '../../apps/worker/usage.ts';
import { launchThrough } from '../support/launch-worker.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from './fixture.ts';

export const noDatabase: boolean = databaseUrlFromEnvironment() === undefined;
const ROOT = resolve(import.meta.dirname, '../..');
/** The synthetic effect's declared receipt host (`receipt-link.ts`). */
export const HOST = 'receipts.stand-in.invalid';
type Name = Parameters<typeof pathOf>[0];

export const answering = (status: number, body: string): Provider => ({
  call: async () => await Promise.resolve({ status, body }),
});
export const linking = (link: unknown): Provider => answering(200, JSON.stringify({ link }));

/** The world's live bindings, filled in by `useReceiptWorld`. */
export const r = {} as {
  fixture: ApiFixture;
  api: Hono;
  personToken: string;
  agentToken: string;
};

const transport: Transport = async (path, body, bearer, delegation) =>
  await r.api.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authorised(bearer),
      ...(delegation === undefined ? {} : { 'x-agent-delegation': delegation }),
    },
    body,
  });

export const asPerson = async (name: Name, body: object): Promise<Answer> =>
  await post(r.api, `/api/b/${BUSINESS_KEY}${pathOf(name)}`, body, authorised(r.personToken));

export const workerOn = (
  credential: string,
  provider?: Provider,
): ReturnType<typeof createWorker> =>
  createWorker({
    transport,
    businessKey: BUSINESS_KEY,
    credential: r.agentToken,
    delegation: credential,
    reporter: SYNTHETIC_USAGE,
    ...(provider === undefined ? {} : { provider }),
  });

async function delegationFor(taskId: string): Promise<string> {
  const { fixture } = r;
  return await fixture.db.app.withBusiness(fixture.business, async (tx) => {
    const minted = await mintDelegation(tx, {
      agentActorId: fixture.agentActorId,
      delegatePersonId: fixture.member.personId,
      mintedByActorId: fixture.member.actorId,
      purpose: `aw08_${randomUUID().slice(0, 8)}`,
      collections: ['task'],
      actions: ['read', 'comment', 'write'],
      purposeScope: { kind: 'record', id: taskId },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
    return minted.value.credential;
  });
}

/**
 * A task with the synthetic change proposed by the worker, its plan accepted,
 * handed back by the worker and its reviewed output launched by the person.
 */
export async function launched(): Promise<{ taskId: string; credential: string }> {
  const created = await asPerson('task.create', {
    operationId: randomUUID(),
    fields: { title: `aw08 receipt ${randomUUID()}` },
  });
  const taskId = String(created.body['recordId']);
  const credential = await delegationFor(taskId);
  const worker = workerOn(credential);
  const proposed = await worker.proposeOnce();
  if (!('proposed' in proposed)) throw new Error(`propose: ${JSON.stringify(proposed)}`);
  const read = await asPerson('task.read', { recordId: taskId });
  const task = read.body['task'] as { proposals: { versions: { versionId: string }[] }[] };
  const decided = await asPerson('task.decide', {
    operationId: randomUUID(),
    gateId: proposed.proposed.gateId,
    versionId: String(task.proposals[0]?.versions[0]?.versionId),
    decision: 'approve',
    note: 'accept the plan',
  });
  expect(decided.status, JSON.stringify(decided.body)).toBe(200);
  await launchThrough(worker, taskId, async (body) => {
    const launch = await asPerson('task.decide', body);
    expect(launch.status, JSON.stringify(launch.body)).toBe(200);
  });
  return { taskId, credential };
}

/** The launched attempts on the task (the reviewed output's): state, markers, link and hold. */
export const attempts = async (taskId: string): Promise<readonly Record<string, unknown>[]> =>
  await r.fixture.db.admin.execute<Record<string, unknown>>(
    `select att.id, att.state, att.observed, att.receipt_link as link, res.state as held,
            res.held_minor::text as held_minor, att.actual_minor
       from public.attempts att
       join public.reservations res on res.business_id = att.business_id and res.id = att.reservation_id
       join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
       join public.reviewed_outputs ro
         on ro.business_id = res.business_id and ro.version_id = res.version_id
      where att.business_id = $1 and run.task_id = $2 order by att.created_at, att.id`,
    [r.fixture.business, taskId],
  );

/** Launch, apply once with `provider`, and read the receipt as the person. */
export async function appliedWith(
  provider: Provider,
): Promise<{ taskId: string; receipt: Record<string, unknown> }> {
  const { taskId, credential } = await launched();
  const outcome = await workerOn(credential, provider).applyOnce(taskId);
  if (!('applied' in outcome)) throw new Error(`apply: ${JSON.stringify(outcome)}`);
  const receipt = await asPerson('task.receipt', { attemptId: outcome.applied.attemptId });
  expect(receipt.status, JSON.stringify(receipt.body)).toBe(200);
  return { taskId, receipt: receipt.body['receipt'] as Record<string, unknown> };
}

/** One live delegation per purpose: retire the worker's pickup delegations before the next launch. */
export async function retirePickups(): Promise<void> {
  await r.fixture.db.admin.execute(
    `update public.delegations set revoked_at = now(), revocation_cause = 'work_retired'
      where business_id = $1 and agent_actor_id = $2 and purpose = 'synthetic_comment'
        and revoked_at is null and settled_at is null`,
    [r.fixture.business, r.fixture.agentActorId],
  );
}

export function useReceiptWorld(part: string): void {
  beforeAll(async () => {
    if (noDatabase) return;
    r.fixture = await createApiFixture(part);
    r.api = r.fixture.compose(undefined, readIdentity(ROOT));
    r.personToken = await tokenFor(r.fixture.member.presented.subject);
    r.agentToken = await tokenFor(r.fixture.agent.subject);
    await r.fixture.db.admin.execute(
      'update public.budget_caps set limit_minor = 1000000000 where business_id = $1',
      [r.fixture.business],
    );
  }, 120_000);

  afterEach(async () => {
    if (!noDatabase) await retirePickups();
  });

  afterAll(async () => {
    if (noDatabase) return;
    await r.fixture.db.drop();
  });
}
