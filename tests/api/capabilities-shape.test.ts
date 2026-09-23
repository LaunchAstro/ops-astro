// SPDX-License-Identifier: AGPL-3.0-only
//
// `session.capabilities`, one shape on both prefixes.
//
// The person prefix answers flattened beside `ok`, which is what the mounted
// app reads. The agent prefix nested the same read under `detail`, where its
// envelope puts every payload (L5-PROOFS handback, "Defects" 4). The agent
// answer is now flattened at the wire, and the register row keeps the handle,
// so a replay of the same operation identity is asserted too: shaping only the
// first answer would hand a retrying agent the old shape.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { authorised, createApiFixture, post, tokenFor, type ApiFixture } from './fixture.ts';

let fixture: ApiFixture;
let api: Hono;
let personToken: string;
let agentToken: string;

beforeAll(async () => {
  fixture = await createApiFixture('capabilities_shape');
  api = fixture.compose();
  personToken = await tokenFor(fixture.member.presented.subject);
  agentToken = await tokenFor(fixture.agent.subject);
}, 60_000);

afterAll(async () => {
  await fixture.drop();
});

describe('session.capabilities on the two prefixes', () => {
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

    const body = { operationId: randomUUID() };
    for (const attempt of ['first', 'replay'] as const) {
      // eslint-disable-next-line no-await-in-loop
      const agent = await post(
        api,
        '/api/a/b/alpha/session/capabilities',
        body,
        authorised(agentToken),
      );
      expect(agent.status, attempt).toBe(200);
      expect(agent.body['ok'], attempt).toBe(true);
      expect(agent.body['detail'], attempt).toBeUndefined();
      expect(agent.body['agentActorId'], attempt).toBe(fixture.agentActorId);
      expect(agent.body['purposeScope'], attempt).toBeNull();
      // The fields both answers share sit at the same level on both.
      expect(agent.body['businessKey'], attempt).toBe(person.body['businessKey']);
      expect(Array.isArray(agent.body['grants']), attempt).toBe(true);
    }
  });
});
