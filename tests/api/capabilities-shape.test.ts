// SPDX-License-Identifier: AGPL-3.0-only
//
// `session.capabilities`, one shape on both prefixes.
//
// The person prefix answers flattened beside `ok`, which is what the mounted
// app reads. The agent prefix nested the same read under `detail`, where its
// envelope puts every payload (L5-PROOFS handback, "Defects" 4). The agent
// answer is now flattened at the wire, and the register row keeps the handle,
// so a replay of the same operation identity is asserted too: shaping only the
// first answer would hand a retrying agent the old shape. The agent asks under
// the delegation a pickup handed it, because before a pickup the read is
// refused (minimum contract 8.2 case 9).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import type { Hono } from 'hono';
import { DELEGATION_HEADER } from '../../packages/core-records/src/commands/surface.ts';
import {
  authorised,
  createApiFixture,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from './fixture.ts';

// Like the other database files, these cases skip without a database
// rather than fail in beforeAll (the CI local checks job has none).
const serverUrl = databaseUrlFromEnvironment();
let fixture: ApiFixture;
let api: Hono;
let personToken: string;
let agentToken: string;

const detailOf = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] as Record<string, unknown> | undefined) ?? answer.body;

/** A task the member approves and the agent picks up, over HTTP; its credential. */
async function pickUp(): Promise<{ readonly credential: string; readonly taskId: string }> {
  const person = async (path: string, body: Record<string, unknown>): Promise<Answer> =>
    await post(api, `/api/b/alpha${path}`, body, authorised(personToken));
  const created = await person('/task/create', {
    operationId: randomUUID(),
    fields: { title: 'a task the agent asks its capabilities under' },
  });
  const taskId = String(created.body['recordId']);
  const proposed = await person('/task/propose', {
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: Number(created.body['revision']),
    purpose: `draft_${randomUUID().slice(0, 8)}`,
    maximumMinor: 3_000,
    currency: 'AUD',
    payload: { instruction: 'draft a reply' },
    step: { kind: 'compose', payload: {} },
  });
  const decided = await person('/task/decide', {
    operationId: randomUUID(),
    gateId: detailOf(proposed)['gateId'],
    versionId: detailOf(proposed)['versionId'],
    decision: 'approve',
    note: 'approved so an agent can work it',
  });
  const pickedUp = await post(
    api,
    '/api/a/b/alpha/task/pickup',
    { operationId: randomUUID(), reservationId: detailOf(decided)['reservationId'] },
    authorised(agentToken),
  );
  expect(pickedUp.status, JSON.stringify(pickedUp.body)).toBe(200);
  return { credential: String(detailOf(pickedUp)['credential']), taskId };
}

beforeAll(async () => {
  if (serverUrl === undefined) return;
  fixture = await createApiFixture('capabilities_shape');
  api = fixture.compose();
  personToken = await tokenFor(fixture.member.presented.subject);
  agentToken = await tokenFor(fixture.agent.subject);
}, 60_000);

afterAll(async () => {
  if (serverUrl !== undefined) await fixture.drop();
});

describe.skipIf(serverUrl === undefined)('session.capabilities on the two prefixes', () => {
  it('answers flattened beside ok on both, and on a replay', async () => {
    const person = await post(
      api,
      '/api/b/alpha/session/capabilities',
      {},
      authorised(personToken),
    );
    expect(person.status).toBe(200);
    expect(person.body['ok']).toBe(true);
    expect(person.body['detail']).toBeUndefined();

    const { credential, taskId } = await pickUp();
    const body = { operationId: randomUUID() };
    for (const attempt of ['first', 'replay'] as const) {
      // eslint-disable-next-line no-await-in-loop
      const agent = await post(api, '/api/a/b/alpha/session/capabilities', body, {
        ...authorised(agentToken),
        [DELEGATION_HEADER]: credential,
      });
      expect(agent.status, attempt).toBe(200);
      expect(agent.body['ok'], attempt).toBe(true);
      expect(agent.body['detail'], attempt).toBeUndefined();
      expect(agent.body['agentActorId'], attempt).toBe(fixture.agentActorId);
      expect(agent.body['purposeScope'], attempt).toStrictEqual({ kind: 'record', id: taskId });
      // The fields both answers share sit at the same level on both.
      expect(agent.body['businessKey'], attempt).toBe(person.body['businessKey']);
      expect(Array.isArray(agent.body['grants']), attempt).toBe(true);
    }
  });
});
