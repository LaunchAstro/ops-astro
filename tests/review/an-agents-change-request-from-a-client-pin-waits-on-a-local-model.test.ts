// SPDX-License-Identifier: AGPL-3.0-only
//
// C57 (#2016): an agent filing a change request from a client's pin would be a model reading
// a client's words, which reaches no model while no local one exists (C60, owner line 72).
// Inside a delegation for the review's own task the agent is refused CLIENT_MODEL_USE_OFF,
// told it waits on a local model, and nothing is filed or asked of any model. Outside that
// task it is refused for the delegation first. A person files the same pin meanwhile.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { c57World, type C57World } from './c57-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C57 agent extraction: DATABASE_URL is unset.');

let w: C57World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c57World('c57agent');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

async function delegatedFor(taskId: string): Promise<string> {
  return await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    const minted = await mintDelegation(tx, {
      agentActorId: w.world.agentActorId,
      delegatePersonId: w.ava.personId,
      mintedByActorId: w.ava.actorId,
      purpose: `propose_${taskId.slice(0, 8)}`,
      collections: ['proposal'],
      actions: ['write'],
      purposeScope: { kind: 'record', id: taskId },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!minted.ok) throw new Error(`mintDelegation refused ${minted.refusal.code}`);
    return minted.value.credential;
  });
}

const modelCalls = async (): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly n: string }>(
        'select count(*)::text as n from public.model_calls where business_id = $1',
        [w.world.business],
      )
    )[0]?.n,
  );

describe.skipIf(serverUrl === undefined)('C57 the agent path', () => {
  it("C57 the agent's extraction is refused by the broker and shows waits on a local model", async () => {
    const { clientPin } = await w.pins();
    const calls = await modelCalls();
    const forA = await delegatedFor(w.taskA);
    const body = { command: 'review.propose_change', commentId: clientPin };

    const asked = await w.world.asAgent({ ...body, operationId: randomUUID() }, forA);
    expect(codeOf(asked)).toBe('CLIENT_MODEL_USE_OFF');
    expect(isCommandRefusal(asked) && asked.fixes.join(' ')).toMatch(/waits on a local model/u);
    // Text the agent wrote itself is a model's reading of the pin too.
    const withText = await w.world.asAgent(
      { ...body, operationId: randomUUID(), text: 'Move the heading' },
      forA,
    );
    expect(codeOf(withText)).toBe('CLIENT_MODEL_USE_OFF');

    const forB = await delegatedFor(w.taskB);
    expect(codeOf(await w.world.asAgent({ ...body, operationId: randomUUID() }, forB))).toBe(
      'DELEGATION_OUT_OF_PURPOSE',
    );

    expect(await w.requests(w.world.business)).toHaveLength(0);
    expect(await modelCalls()).toBe(calls);
    // A person files the same pin while the agent waits.
    expect(codeOf(await w.propose(w.ava, clientPin))).toBe('not-a-refusal');
  });
});
