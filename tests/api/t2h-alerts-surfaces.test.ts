// SPDX-License-Identifier: AGPL-3.0-only
//
// T2h through the served API and the command line: the worker proposes, a
// person approves, the worker applies it once and its observed cost settles.
// That settlement's one alert reads the same through `task.read` over HTTP and
// `task.queue` through the command line's client. A real second business,
// read by its own member's token, answers its queue (200) with none of it.

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { readIdentity } from '../../apps/api/identity.ts';
import { createCli, type Transport } from '../../apps/cli/client.ts';
import { createWorker } from '../../apps/worker/worker.ts';
import { SYNTHETIC_USAGE } from '../../apps/worker/usage.ts';
import { enrol, grantTo, installSpine } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
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
  console.warn('api/t2h: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

type Name = Parameters<typeof pathOf>[0];

describe.skipIf(serverUrl === undefined)('T2h: the alert on every surface', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let personToken: string;
  let agentToken: string;
  let bravoToken: string;

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

  beforeAll(async () => {
    fixture = await createApiFixture('t2h');
    api = fixture.compose(undefined, readIdentity(ROOT));
    personToken = await tokenFor(fixture.member.presented.subject);
    agentToken = await tokenFor(fixture.agent.subject);
    await fixture.db.admin.execute(
      'update public.budget_caps set limit_minor = 1000000000 where business_id = $1',
      [fixture.business],
    );
    const bravo = await insertBusiness(fixture.db.app, 'bravo');
    await installSpine(fixture.db.app, bravo);
    const reader = await enrol(fixture.db.app, bravo, 'bravo-member');
    await fixture.db.app.withBusiness(bravo, async (tx) => {
      await grantTo(tx, reader, 'read');
    });
    bravoToken = await tokenFor(reader.presented.subject);
  }, 120_000);

  afterAll(async () => {
    await fixture?.db.drop();
  });

  it('alert_on_transition on the API and the command line: one settled alert, the same on both', async () => {
    const created = await asPerson('task.create', {
      operationId: randomUUID(),
      fields: { title: `t2h ${randomUUID()}` },
    });
    const taskId = String(created.body['recordId']);
    const credential = await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      const minted = await mintDelegation(tx, {
        agentActorId: fixture.agentActorId,
        delegatePersonId: fixture.member.personId,
        mintedByActorId: fixture.member.actorId,
        purpose: `t2h_${randomUUID().slice(0, 8)}`,
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
    const before = await asPerson('task.read', { recordId: taskId });
    const task = before.body['task'] as {
      proposals: { versions: { versionId: string }[] }[];
      alerts: unknown[];
    };
    expect(task.alerts).toStrictEqual([]);
    const decided = await asPerson('task.decide', {
      operationId: randomUUID(),
      gateId: proposed.proposed.gateId,
      versionId: String(task.proposals[0]?.versions[0]?.versionId),
      decision: 'approve',
      note: 'approve this version',
    });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    const applied = await worker.applyOnce(taskId);
    if (!('applied' in applied)) throw new Error(`apply: ${JSON.stringify(applied)}`);

    const read = await asPerson('task.read', { recordId: taskId });
    const onPage = (read.body['task'] as { alerts: Record<string, unknown>[] }).alerts;
    expect(onPage).toHaveLength(1);
    expect(onPage[0]).toMatchObject({
      taskId,
      kind: 'settled',
      waitingReason: null,
      causeId: applied.applied.attemptId,
    });

    const cli = createCli({ transport, businessKey: BUSINESS_KEY, credential: personToken });
    const queue = await cli.run('task.queue', {});
    expect(queue.status, queue.text).toBe(200);
    const inQueue = (
      (queue.body as Record<string, unknown>)['alerts'] as Record<string, unknown>[]
    ).filter((alert) => alert['taskId'] === taskId);
    expect(inQueue).toStrictEqual(onPage);

    const foreign = createCli({ transport, businessKey: 'bravo', credential: bravoToken });
    const theirs = await foreign.run('task.queue', {});
    expect(theirs.status, theirs.text).toBe(200);
    expect(theirs.body).toMatchObject({ ok: true, alerts: [] });
    expect(theirs.text).not.toContain(taskId);
  });
});
