// SPDX-License-Identifier: AGPL-3.0-only
//
// `delegation.revoke` over a delegation that reaches `run` (ORCH34 ruling on
// MP-6-2), through the real boundary and a fresh Postgres. The revoke reads
// each collection only within its action ceiling (`run` carries `write`), and
// judges `run`'s pair on the task collection at the delegation's purpose
// task: run reach exists only inside a task delegation on that task, and no
// person holds `run:manage`. The stored delegation, read with the admin role,
// is the oracle.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Action } from '../../packages/core-records/src/authority/grants.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { approvedReservationId } from '../acceptance/role-case-bodies.ts';
import {
  agentPath,
  bearer,
  call,
  createWorld,
  serverUrl,
  tokenFor,
  type World,
} from '../acceptance/world.ts';
import {
  asAgent,
  asPerson,
  contextOf,
  externalClient,
  signed,
  type Signed,
} from './c54-fixture.ts';

interface Picked {
  readonly taskId: string;
  readonly delegationId: string;
  readonly credential: string;
  readonly collections: readonly string[];
}

const CEILING_WORDS = 'A manager revokes only what it could hold itself';

// eslint-disable-next-line max-lines-per-function -- one world, each revoke on it
describe.skipIf(serverUrl === undefined)('MP-6-2 delegation.revoke over run reach', () => {
  let world: World;
  let ada: Signed;

  beforeAll(async () => {
    world = await createWorld('mp62revoke');
    ada = signed(world.ada);
  }, 120_000);

  afterAll(async () => await world?.close());

  /** Work ada approved, picked up by the agent: its delegation and what it reaches. */
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
    const taskId = String(detail['taskId']);
    const rows = await world.db.admin.execute<{
      readonly id: string;
      readonly collections: readonly string[];
    }>(
      `select id, collections from public.delegations
        where business_id = $1 and purpose_scope_id = $2 order by granted_at desc limit 1`,
      [world.alpha, taskId],
    );
    return {
      taskId,
      delegationId: String(rows[0]?.id),
      credential: String(detail['credential']),
      collections: [...(rows[0]?.collections ?? [])],
    };
  }

  /** A person of `business` holding `actions` on the task collection, on one task or the business. */
  async function holder(
    business: BusinessId,
    businessKey: string,
    name: string,
    actions: readonly Action[],
    taskId?: string,
  ): Promise<Signed> {
    const made = await enrol(world.db.app, business, name);
    const scope = taskId === undefined ? undefined : { kind: 'record' as const, id: taskId };
    await world.db.app.withBusiness(business, async (tx) => {
      for (const action of actions) {
        // eslint-disable-next-line no-await-in-loop -- a handful of grants
        await grantTo(tx, made, action, scope);
      }
    });
    return { ...made, token: await tokenFor(made.presented.subject), businessKey };
  }

  const revokedAt = async (delegationId: string): Promise<string | null> =>
    (
      await world.db.admin.execute<{ readonly revoked_at: string | null }>(
        `select revoked_at::text from public.delegations where id = $1`,
        [delegationId],
      )
    )[0]?.revoked_at ?? null;

  const revoke = async (who: Signed, delegationId: string) =>
    await asPerson(world, who, 'delegation.revoke', { delegationId });

  it('revokes a task-only delegation as before: a task manager at its task, one without task:write refused by the ceiling', async () => {
    const work = await pickUp();
    expect(work.collections).toStrictEqual(['task']);
    const short = await holder(world.alpha, 'alpha', 'mp62-short', ['manage', 'read'], work.taskId);
    const refusedAnswer = await revoke(short, work.delegationId);
    expect(refusedAnswer.code).toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(refusedAnswer.body)).toContain(CEILING_WORDS);
    const manager = await holder(
      world.alpha,
      'alpha',
      'mp62-task-manager',
      ['manage', 'read', 'comment', 'write'],
      work.taskId,
    );
    const answer = await revoke(manager, work.delegationId);
    expect(answer.code).toBe('ok');
    expect(await revokedAt(work.delegationId)).not.toBeNull();
  });

  it('MP-6-2 revoke run reach: a task manager at the purpose task revokes a delegation that reaches run; without task:write it is refused by the ceiling, and nothing is revoked', async () => {
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      await grantTo(tx, ada, 'write', undefined, false, 'run');
    });
    const work = await pickUp();
    expect(work.collections).toStrictEqual(['task', 'run']);
    const short = await holder(
      world.alpha,
      'alpha',
      'mp62-run-short',
      ['manage', 'read', 'comment'],
      work.taskId,
    );
    const refusedAnswer = await revoke(short, work.delegationId);
    expect(refusedAnswer.code).toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(refusedAnswer.body)).toContain(CEILING_WORDS);
    expect(await revokedAt(work.delegationId)).toBeNull();
    const manager = await holder(
      world.alpha,
      'alpha',
      'mp62-run-manager',
      ['manage', 'read', 'comment', 'write'],
      work.taskId,
    );
    const answer = await revoke(manager, work.delegationId);
    expect(answer.code).toBe('ok');
    expect(await revokedAt(work.delegationId)).not.toBeNull();
  });

  it('MP-6-2 revoke isolation: another business, another client and another person’s agent revoke none of it', async () => {
    const work = await pickUp();
    expect(work.collections).toStrictEqual(['task', 'run']);
    // Another business: bravo's manager of everything names alpha's delegation.
    const bravo = await holder(world.bravo, 'bravo', 'mp62-bravo', [
      'manage',
      'read',
      'comment',
      'write',
    ]);
    const foreign = await revoke(bravo, work.delegationId);
    const fabricated = await revoke(bravo, randomUUID());
    expect(foreign.status).toBe(404);
    expect(foreign.body).toStrictEqual(fabricated.body);
    // Another client in the same business, on the task shared with them.
    const client = await externalClient(world, ada, work.taskId);
    const theirs = await revoke(client, work.delegationId);
    expect(theirs.status).toBe(403);
    // Another person under a live delegation: the agent revokes nothing.
    const delegated = await asAgent(
      world,
      'delegation.revoke',
      { delegationId: work.delegationId },
      work.credential,
    );
    expect(delegated.status).toBe(403);
    expect(await revokedAt(work.delegationId)).toBeNull();
  });
});
