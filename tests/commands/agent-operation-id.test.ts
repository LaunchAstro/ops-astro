// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent's operation identity is a string or it is no identity (Sol 6
// AUTHORITY-4, the envelope half).
//
// `RegExp.prototype.test` coerces its argument, so a number or a one-element
// array passes the pattern as the string it would print as, and would then be
// registered or collide with a later request carrying that string. The person
// envelope asks `typeof` first (`envelope.ts`); the agent envelope must answer
// the same whatever the HTTP boundary hands it: `OPERATION_ID_REQUIRED` and no
// register row. Only the string identity registers.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { agentWorld, codeOf, type AgentWorld } from './agent-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('agent operation identity', () => {
  let world: AgentWorld;

  beforeAll(async () => {
    world = await agentWorld('opid', 'agent-operation-id');
  }, 90_000);

  afterAll(async () => {
    await world?.drop();
  });

  const registered = async (): Promise<readonly string[]> =>
    (
      await world.db.admin.execute<{ readonly operation_id: string }>(
        `select operation_id from public.operations
          where business_id = $1 and actor_id = $2 order by operation_id`,
        [world.business, world.agentActorId],
      )
    ).map((row) => row.operation_id);

  const refusedAudits = async (): Promise<number> =>
    Number(
      (
        await world.db.admin.execute<{ readonly n: string }>(
          `select count(*)::text as n from public.audit_events
            where business_id = $1 and actor_id = $2
              and outcome = 'refused' and refusal_code = 'OPERATION_ID_REQUIRED'`,
          [world.business, world.agentActorId],
        )
      )[0]?.n,
    );

  it.each([
    ['a number', { operationId: 12_345_678 }],
    ['an array', { operationId: ['12345678'] }],
    ['null', { operationId: null }],
    ['absent', {}],
  ])('refuses %s as the identity and registers nothing', async (_label, identity) => {
    const before = await refusedAudits();
    const answer = await world.asAgent({ command: 'task.queue', ...identity });
    console.log(`operationId ${JSON.stringify(identity)}: ${codeOf(answer)}`);
    expect(codeOf(answer)).toBe('OPERATION_ID_REQUIRED');
    expect(await registered()).not.toContain('12345678');
    expect(await refusedAudits()).toBe(before + 1);
  });

  it('registers the same identity when it is sent as a string', async () => {
    const answer = await world.asAgent({ command: 'task.queue', operationId: '12345678' });
    expect(codeOf(answer)).toBe('not-a-refusal');
    expect(await registered()).toContain('12345678');
  });
});
