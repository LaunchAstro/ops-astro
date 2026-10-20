// SPDX-License-Identifier: AGPL-3.0-only
//
// The reads that name a record by id answer the same for either letter case
// of the id: a receipt by its attempt, and a board scoped to one record.

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
import { launchThrough } from '../support/launch-worker.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type ApiFixture,
} from './fixture.ts';
import { COMPUTES_NOTHING } from '../support/computes-nothing-runner.ts';

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

const person = async (name: Parameters<typeof pathOf>[0], body: object) =>
  await post(api, `/api/b/${BUSINESS_KEY}${pathOf(name)}`, body, authorised(personToken));

const workerOn = (delegation: string) =>
  createWorker({
    transport,
    businessKey: BUSINESS_KEY,
    credential: agentToken,
    delegation,
    reporter: SYNTHETIC_USAGE,
    runner: COMPUTES_NOTHING,
  });

async function approved() {
  const created = await person('task.create', {
    operationId: randomUUID(),
    fields: { title: `id case ${randomUUID()}` },
  });
  expect(created.status).toBe(200);
  const taskId = String(created.body['recordId']);
  const credential = await fixture.db.app.withBusiness(fixture.business, async (tx) => {
    const minted = await mintDelegation(tx, {
      agentActorId: fixture.agentActorId,
      delegatePersonId: fixture.member.personId,
      mintedByActorId: fixture.member.actorId,
      purpose: `id_case_${randomUUID().slice(0, 8)}`,
      collections: ['task'],
      actions: ['read', 'comment', 'write'],
      purposeScope: { kind: 'record', id: taskId },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
    return minted.value.credential;
  });
  const worker = workerOn(credential);
  const proposed = await worker.proposeOnce();
  if (!('proposed' in proposed)) throw new Error(JSON.stringify(proposed));
  const [version] = await fixture.db.admin.execute<{ readonly id: string }>(
    'select version_id as id from public.gates where id = $1',
    [proposed.proposed.gateId],
  );
  const decided = await person('task.decide', {
    operationId: randomUUID(),
    gateId: proposed.proposed.gateId,
    versionId: version?.id,
    decision: 'approve',
    note: 'approved before restart',
  });
  expect(decided.status, JSON.stringify(decided.body)).toBe(200);
  return { taskId, credential, worker, proposed };
}

beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  fixture = await createApiFixture('id_case');
  api = fixture.compose(undefined, readIdentity(resolve(import.meta.dirname, '../..')));
  personToken = await tokenFor(fixture.member.presented.subject);
  agentToken = await tokenFor(fixture.agent.subject);
}, 180_000);

afterAll(async () => {
  await fixture?.db.drop();
});

describe.skipIf(databaseUrlFromEnvironment() === undefined)('reads given either id case', () => {
  it('an observed receipt reads identically with an uppercase attempt UUID', async () => {
    const { taskId, worker } = await approved();
    await launchThrough(worker, taskId, async (body) => {
      const launch = await person('task.decide', body);
      expect(launch.status, JSON.stringify(launch.body)).toBe(200);
      return launch.body['detail'] as Record<string, unknown>;
    });
    const applied = await worker.applyOnce(taskId);
    if (!('applied' in applied)) throw new Error(JSON.stringify(applied));
    const id = applied.applied.attemptId;
    expect(id).not.toBe(id.toUpperCase());
    const lower = await person('task.receipt', { attemptId: id });
    expect(lower.status).toBe(200);
    const upper = await person('task.receipt', { attemptId: id.toUpperCase() });
    expect(upper.body).toStrictEqual(lower.body);
  });

  it('a record-scoped board read accepts either UUID spelling', async () => {
    const made = await person('task.create', {
      operationId: randomUUID(),
      fields: { title: 'scoped board' },
    });
    expect(made.status).toBe(200);
    const id = String(made.body['recordId']);
    expect(id).not.toBe(id.toUpperCase());
    const reader = await enrol(fixture.db.app, fixture.business, 'scoped-reader');
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await grantTo(tx, reader, 'read', { kind: 'record', id });
    });
    const lower = await executeRead(fixture.db.app, fixture.business, reader.presented, {
      read: 'task.board',
      board: id,
    });
    expect(lower).toHaveProperty('tasks');
    const upper = await executeRead(fixture.db.app, fixture.business, reader.presented, {
      read: 'task.board',
      board: id.toUpperCase(),
    });
    expect(upper).toStrictEqual(lower);
  });
});
