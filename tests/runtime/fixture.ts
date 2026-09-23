// SPDX-License-Identifier: AGPL-3.0-only
//
// A task, a person who may decide about it, an agent that may pick it up, and
// a finite synthetic cap.
//
// It builds nothing the product would not build. The task is created through
// the real `task.create` command path, not inserted, because a seeded task is
// a task nobody created and it makes every case below pass against a product
// that does not work. The cap is a real row with a real finite limit; it is
// the fixture's synthetic ceiling and not a proposed production budget.

import { randomUUID } from 'node:crypto';
import type { Database, TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import {
  enrol,
  grantTo,
  installSpine,
  TASK_COLLECTION,
  WHOLE_BUSINESS,
  type Member,
} from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import type { SigningKey } from '../../packages/core-runtime/src/signing.ts';

/** Isolated, created in the test, never a production key. */
export const TEST_SIGNING_KEY: SigningKey = {
  id: 'test/isolated-gate-key@1',
  secret: randomUUID(),
};

export interface RuntimeFixture {
  readonly businessId: string;
  readonly decider: Member;
  readonly agentActorId: string;
  readonly taskId: string;
  readonly capId: string;
}

export const CAP_LIMIT_MINOR = 100_000;

export async function buildFixture(database: Database, key: string): Promise<RuntimeFixture> {
  const businessId = await insertBusiness(database, key);
  await installSpine(database, businessId);

  const decider = await enrol(database, businessId, 'decider');
  await database.withBusiness(businessId, async (tx) => {
    for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
      // One transaction, one grant at a time: `issueGrant` reads the granter's
      // own rows, so issuing these in parallel would interleave those reads.
      // eslint-disable-next-line no-await-in-loop
      await grantTo(tx, decider, action, WHOLE_BUSINESS, true);
    }
  });

  const taskId = await createTask(database, businessId, decider);

  const agentActorId = await database.withBusiness(businessId, async (tx) => {
    const actorId = randomUUID();
    await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      businessId,
      actorId,
    ]);
    const loginId = await insertLogin(tx, `agent-${randomUUID()}`);
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [businessId, randomUUID(), loginId, actorId, decider.actorId],
    );
    return actorId;
  });

  const capId = await database.withBusiness(businessId, async (tx) => {
    const id = randomUUID();
    await tx.query(
      `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
       values ($1, $2, 'synthetic', $3, 'AUD')`,
      [businessId, id, CAP_LIMIT_MINOR],
    );
    return id;
  });

  return { businessId, decider, agentActorId, taskId, capId };
}

/** Through the real command path. */
async function createTask(database: Database, businessId: string, member: Member): Promise<string> {
  const outcome = await executeCommand(database, businessId, member.presented, 'api', {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title: 'bounded work' },
  } as never);
  if (isCommandRefusal(outcome)) throw new Error(`fixture: task.create refused ${outcome.code}`);
  if (outcome.recordId === null)
    throw new Error('fixture: task.create returned no record identity');
  return outcome.recordId;
}

/** The subjects a decider presents. The same shape `grants.ts` builds from a session. */
export function subjectsOf(member: Member): readonly { kind: 'person'; id: string }[] {
  return [{ kind: 'person', id: member.personId }];
}

/** Sum the envelope's two totals, which is what every invariant below compares. */
export async function envelopeTotals(
  tx: TenantQuery,
  envelopeId: string,
): Promise<{ readonly held: number; readonly actual: number; readonly maximum: number }> {
  const rows = await tx.query<{
    readonly held_minor: string;
    readonly actual_minor: string;
    readonly maximum_minor: string;
  }>(
    `select held_minor::text as held_minor, actual_minor::text as actual_minor,
            maximum_minor::text as maximum_minor
       from public.task_envelopes where business_id = $1 and id = $2`,
    [tx.businessId, envelopeId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`no envelope ${envelopeId}`);
  return {
    held: Number(row.held_minor),
    actual: Number(row.actual_minor),
    maximum: Number(row.maximum_minor),
  };
}

export { insertPerson, insertActor, insertMembership, insertMapping, TASK_COLLECTION };
