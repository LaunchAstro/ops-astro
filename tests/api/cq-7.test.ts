// SPDX-License-Identifier: AGPL-3.0-only
//
// CQ-7 on the database, through the composed API.
//
// `CQ-7 cap currency`: `task.read` carries the currency of the cap an approval
// on the task would draw on, and a proposal made in it is approved, not refused
// `CAP_BINDING_MISMATCH`. The fixed AUD the form used to offer is refused
// against the same cap, which is the disagreement this closes (product issue
// 71).
//
// `CQ-7 isolation`: two businesses, two clients, one grant each. The cap and
// its currency are read inside the task read, so a reader who may not read the
// task is told nothing about the cap: another business's task, and a task for
// the other client, answer with no currency, no cap and no proposal count.
// This build has no party link on a task, so a client is a person outside the
// business's staff holding one record-scoped grant on its own task (R4).
//
// `CQ-7 task:write refused`: `task.propose` still checks `task:write`. A client
// holding only `read` on its task is refused, and nothing is written.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { createControls, detailOf, PROPOSAL, type Controls } from './controls-fixture.ts';
import { authorised, post, tokenFor, type Answer } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const BETA = 'beta';

const task = (answer: Answer): Record<string, unknown> =>
  (answer.body['task'] as Record<string, unknown> | undefined) ?? {};

/** A refused read says nothing about the cap, its currency or the proposals. */
const tellsNothing = (answer: Answer): void => {
  expect(answer.status).not.toBe(200);
  expect(answer.body['refused']).toBe(true);
  const said = JSON.stringify(answer.body);
  for (const leak of ['capCurrency', 'USD', 'NZD', 'proposals', 'limit_minor', 'maximumMinor']) {
    expect(said).not.toContain(leak);
  }
};

describe.skipIf(serverUrl === undefined)('CQ-7 on the task read', () => {
  let c: Controls;
  let betaId: string;
  let betaMember: Member;
  let clientX: Member;
  let clientY: Member;
  let taskX: { id: string; revision: number };
  let taskY: { id: string; revision: number };
  let taskB: string;

  /** A call on a business's person prefix as a member of it (or not). */
  const as = async (
    who: Member,
    name: string,
    body: Readonly<Record<string, unknown>>,
    businessKey = 'alpha',
  ): Promise<Answer> =>
    await post(
      c.api,
      `/api/b/${businessKey}/${name.replace('.', '/')}`,
      body,
      authorised(await tokenFor(who.presented.subject)),
    );

  beforeAll(async () => {
    c = await createControls('cq7');
    const { db } = c.fixture;
    // Business alpha's cap is in USD, so AUD (the form's old fixed list) is
    // the wrong currency for every task in it. No envelope draws on it yet.
    await db.admin.execute(
      `update public.budget_caps set currency = 'USD' where business_id = $1`,
      [c.fixture.business],
    );
    taskX = await c.createTask('client X renewal');
    taskY = await c.createTask('client Y renewal');

    clientX = await enrol(db.app, c.fixture.business, 'client-x');
    clientY = await enrol(db.app, c.fixture.business, 'client-y');
    await db.app.withBusiness(c.fixture.business, async (tx) => {
      await grantTo(tx, clientX, 'read', { kind: 'record', id: taskX.id });
      await grantTo(tx, clientY, 'read', { kind: 'record', id: taskY.id });
    });

    // Business beta: its own member, its own cap in NZD, its own task.
    betaId = await insertBusiness(db.app, BETA);
    await installSpine(db.app, betaId);
    betaMember = await enrol(db.app, betaId, 'beta-member');
    await db.app.withBusiness(betaId, async (tx) => {
      await grantTo(tx, betaMember, 'read');
      await grantTo(tx, betaMember, 'write');
      await tx.query(
        `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
         values ($1, gen_random_uuid(), 'local', 100000000, 'NZD')`,
        [betaId],
      );
    });
    const created = await as(
      betaMember,
      'task.create',
      { operationId: crypto.randomUUID(), fields: { title: 'beta task' } },
      BETA,
    );
    expect(created.status).toBe(200);
    taskB = String(created.body['recordId']);
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  it("CQ-7 cap currency: task.read carries the cap's currency and a proposal in it is approved", async () => {
    const task1 = await c.createTask('a task proposed on in the cap currency');
    const read = await c.asPerson('task.read', { recordId: task1.id });
    expect(read.status).toBe(200);
    expect(task(read)['capCurrency']).toBe('USD');

    const proposal = await c.asPerson('task.propose', {
      recordId: task1.id,
      expectedRevision: task1.revision,
      ...PROPOSAL,
      currency: task(read)['capCurrency'],
    });
    expect(proposal.status).toBe(200);
    const decided = await c.asPerson('task.decide', {
      gateId: detailOf(proposal)['gateId'],
      versionId: detailOf(proposal)['versionId'],
      decision: 'approve',
      note: 'approved in the cap currency',
    });
    expect(decided.body['code']).not.toBe('CAP_BINDING_MISMATCH');
    expect(decided.status).toBe(200);
    expect(detailOf(decided)['reservationId']).toEqual(expect.any(String));

    // After the approval the envelope's cap is the one read: still USD.
    const reread = await c.asPerson('task.read', { recordId: task1.id });
    expect(task(reread)['capCurrency']).toBe('USD');
  });

  it('CQ-7 cap currency: the old fixed AUD offer is refused against the same cap', async () => {
    // What the form offered before: AUD, whatever the cap held. The proposal
    // is refused before it is stored, so nobody is ever asked to approve it.
    const task2 = await c.createTask('a task proposed on in the old fixed currency');
    const proposal = await c.asPerson('task.propose', {
      recordId: task2.id,
      expectedRevision: task2.revision,
      ...PROPOSAL,
      currency: 'AUD',
    });
    expect(proposal.status).toBe(403);
    expect(proposal.body['code']).toBe('PROPOSAL_OUT_OF_SCOPE');
  });

  it('CQ-7 cap currency: each business reads its own cap', async () => {
    const beta = await as(betaMember, 'task.read', { recordId: taskB }, BETA);
    expect(beta.status).toBe(200);
    expect(task(beta)['capCurrency']).toBe('NZD');
  });

  it('CQ-7 isolation: client to client, one record grant each', async () => {
    const own = await as(clientX, 'task.read', { recordId: taskX.id });
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).not.toContain(taskY.id);

    tellsNothing(await as(clientX, 'task.read', { recordId: taskY.id }));
    tellsNothing(await as(clientY, 'task.read', { recordId: taskX.id }));
  });

  it('CQ-7 isolation: business to business', async () => {
    // Beta's task named on alpha's path is not alpha's to read.
    tellsNothing(await as(c.manager, 'task.read', { recordId: taskB }));
    // Alpha's task named on beta's path, by beta's member.
    tellsNothing(await as(betaMember, 'task.read', { recordId: taskX.id }, BETA));
    // Alpha's people on beta's path hold nothing there.
    tellsNothing(await as(c.manager, 'task.read', { recordId: taskB }, BETA));
    tellsNothing(await as(clientX, 'task.read', { recordId: taskB }, BETA));
  });

  it('CQ-7 isolation: person to person', async () => {
    // Client Y's grant is Y's alone: X holding a grant on the business does
    // not lend it to Y, and neither reads the other's task.
    const mine = await as(clientY, 'task.read', { recordId: taskY.id });
    expect(mine.status).toBe(200);
    tellsNothing(await as(clientY, 'task.read', { recordId: taskX.id }));
    tellsNothing(await as(betaMember, 'task.read', { recordId: taskY.id }, BETA));
  });

  it('CQ-7 task:write refused: a proposal without task:write is refused and writes nothing', async () => {
    const before = await c.count(
      `select count(*)::text as n from public.proposal_versions where business_id = $1`,
      [c.fixture.business],
    );
    const refused = await as(clientX, 'task.propose', {
      operationId: crypto.randomUUID(),
      recordId: taskX.id,
      expectedRevision: taskX.revision,
      ...PROPOSAL,
      currency: 'USD',
    });
    expect(refused.status).toBe(403);
    expect(refused.body['code']).toBe('SCOPE_NOT_GRANTED');
    const after = await c.count(
      `select count(*)::text as n from public.proposal_versions where business_id = $1`,
      [c.fixture.business],
    );
    expect(after).toBe(before);
  });
});
