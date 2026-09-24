// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol 6 AUTHORITY-4, both halves. The agent envelope asks `typeof` itself
// (`commands/agent-envelope.ts`), so the boundary in front of it passes the
// body's `operationId` through exactly as the JSON carried it: a number, an
// array, null and an absent field each reach the envelope as themselves, and
// each is refused `OPERATION_ID_REQUIRED` 422 with nothing written to the
// register. A boundary that rewrote them would hide from the envelope what the
// caller sent, and would be a second place the rule lived.
//
// The 422 cases go through `composeApi`, the server's own wiring. The
// pass-through case builds the same boundary around a recorder that hands
// each request to the real envelope after noting what arrived.

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  executeAgentCommand,
  type AgentRequest,
} from '../../packages/core-records/src/commands/agent-envelope.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import {
  authorised,
  createApiFixture,
  createBusinessResolver,
  SECRET,
  tokenFor,
  type ApiFixture,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const PATH = '/api/a/b/alpha/task/queue';

/** Each non-string the JSON can carry, and what the body holds for it. */
const NOT_A_STRING = [
  ['a number', { operationId: 12_345_678 }],
  ['an array', { operationId: ['12345678'] }],
  ['null', { operationId: null }],
  ['an absent field', {}],
] as const;

describe.skipIf(serverUrl === undefined)('the agent boundary passes operationId as sent', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let token: string;

  async function registered(): Promise<number> {
    const rows = await fixture.db.admin.execute<{ n: string }>(
      'select count(*)::text as n from public.operations where business_id = $1',
      [fixture.business],
    );
    return Number(rows[0]?.n);
  }

  async function send(app: Hono, body: object): Promise<{ status: number; body: unknown }> {
    const response = await app.fetch(
      new Request(`http://api.test${PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authorised(token) },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: await response.json() };
  }

  beforeAll(async () => {
    fixture = await createApiFixture('api_agent_operation_id');
    api = fixture.compose();
    token = await tokenFor(fixture.agent.subject);
  }, 60_000);

  afterAll(async () => {
    await fixture?.drop();
  });

  for (const [label, body] of NOT_A_STRING) {
    it(`${label} is OPERATION_ID_REQUIRED 422 and registers nothing`, async () => {
      const before = await registered();
      const answer = await send(api, body);
      expect(answer.status).toBe(422);
      expect(answer.body).toMatchObject({ refused: true, code: 'OPERATION_ID_REQUIRED' });
      expect(await registered()).toBe(before);
    });
  }

  it('hands the envelope the raw value, not a rewritten one', async () => {
    const seen: AgentRequest[] = [];
    const recording = createApi({
      database: fixture.db.app,
      verify: createSupabaseVerifier({ secret: SECRET }),
      resolveBusiness: createBusinessResolver(fixture.db.admin),
      executeCommand,
      executeAgentCommand: async (database, businessId, presented, credential, request) => {
        seen.push(request);
        return await executeAgentCommand(database, businessId, presented, credential, request);
      },
    });

    for (const [, body] of NOT_A_STRING) {
      // Sequential so `seen` lines up with the bodies sent.
      // eslint-disable-next-line no-await-in-loop
      expect((await send(recording, body)).status).toBe(422);
    }

    expect(seen.map((request) => request.operationId)).toStrictEqual([
      12_345_678,
      ['12345678'],
      null,
      undefined,
    ]);
    expect(Object.hasOwn(seen[3] ?? {}, 'operationId')).toBe(false);
  });

  it('a string still reaches the queue', async () => {
    const answer = await send(api, { operationId: `queue-${randomUUID()}` });
    expect(answer.status).toBe(200);
  });
});
