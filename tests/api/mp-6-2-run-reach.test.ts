// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-2's `run:write` at pickup (ORCH34 ruling), through the real boundary
// and a fresh Postgres: the agent's delegation reaches `run` only when the
// person who approved the work holds `run:write`, and then reaches `write` on
// it and nothing else. A delegation minted for a person without it is the
// task delegation it always was. The stored delegation, read with the admin
// role, and the agent's own capabilities read are the oracle.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantTo } from '../commands/fixture.ts';
import { approvedReservationId } from '../acceptance/role-case-bodies.ts';
import {
  agentPath,
  bearer,
  call,
  createWorld,
  serverUrl,
  type World,
} from '../acceptance/world.ts';
import { asAgent, contextOf, signed, type Signed } from './c54-fixture.ts';

interface Picked {
  readonly taskId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly credential: string;
}

// eslint-disable-next-line max-lines-per-function -- one world, each pickup case on it
describe.skipIf(serverUrl === undefined)('MP-6-2 run reach at pickup', () => {
  let world: World;
  let ada: Signed;

  beforeAll(async () => {
    world = await createWorld('mp62reach');
    ada = signed(world.ada);
  }, 120_000);

  afterAll(async () => await world?.close());

  /** Work ada approved, picked up by the agent. */
  async function pickUp(): Promise<Picked> {
    const reservationId = await approvedReservationId(contextOf(world, ada));
    const picked = await call(
      world.api,
      agentPath('alpha', '/task/pickup'),
      { operationId: randomUUID(), reservationId },
      bearer(world.agent.token),
    );
    if (picked.code !== 'ok') throw new Error(`mp-6-2: agent pickup refused ${picked.code}`);
    const detail = picked.body['detail'] as Record<string, unknown>;
    return {
      taskId: String(detail['taskId']),
      leaseId: String(detail['leaseId']),
      fence: Number(detail['fence']),
      credential: String(detail['credential']),
    };
  }

  /** The agent settles the work, so its delegation for the purpose is spent. */
  async function handBack(work: Picked): Promise<void> {
    const settled = await asAgent(
      world,
      'task.handback',
      {
        leaseId: work.leaseId,
        fence: work.fence,
        outcome: 'completed',
        report: { wrote: 'the run is done' },
      },
      work.credential,
    );
    if (settled.code !== 'ok') throw new Error(`mp-6-2: handback refused ${settled.code}`);
  }

  async function collectionsOf(taskId: string): Promise<readonly string[]> {
    const rows = await world.db.admin.execute<{ readonly collections: readonly string[] }>(
      `select collections from public.delegations
        where business_id = $1 and purpose_scope_id = $2 order by granted_at desc limit 1`,
      [world.alpha, taskId],
    );
    return rows[0]?.collections ?? [];
  }

  async function runPairs(work: Picked): Promise<readonly string[]> {
    const read = await asAgent(world, 'session.capabilities', {}, work.credential);
    expect(read.code, 'session.capabilities').toBe('ok');
    const body = (read.body['detail'] as Record<string, unknown> | undefined) ?? read.body;
    const grants = body['grants'] as readonly Record<string, string>[];
    return grants
      .filter((grant) => grant['collection'] === 'run')
      .map((grant) => String(grant['action']));
  }

  it('MP-6-2 run:write refused: a person without run:write mints no run reach, the task delegation unchanged', async () => {
    const work = await pickUp();
    expect(await collectionsOf(work.taskId)).toStrictEqual(['task']);
    expect(await runPairs(work)).toStrictEqual([]);
    await handBack(work);
  });

  it('MP-6-2 run reach: a person holding run:write mints task and run, and the agent reaches run:write only', async () => {
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      await grantTo(tx, ada, 'write', undefined, false, 'run');
    });
    const work = await pickUp();
    expect(await collectionsOf(work.taskId)).toStrictEqual(['task', 'run']);
    expect(await runPairs(work)).toStrictEqual(['write']);
    await handBack(work);
  });
});
