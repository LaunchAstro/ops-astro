// SPDX-License-Identifier: AGPL-3.0-only
//
// Bravo's side of the cost world (`world.ts`): a manager and an agent of its
// own, installed as the API fixture installs alpha's, and one real run through
// bravo's own routes, so each business's cost reads have the other's spend to
// leave out.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { insertLogin } from '../identity/fixture.ts';
import { authorised, post, tokenFor, type Answer } from '../api/fixture.ts';
import { PROPOSAL, type Controls } from '../api/controls-fixture.ts';

/** A run the world made: its id and its task's. */
export interface Ran {
  readonly runId: string;
  readonly taskId: string;
}

const detail = (body: Record<string, unknown>): Record<string, unknown> =>
  body['detail'] as Record<string, unknown>;

const must = (answer: Answer, name: string): Record<string, unknown> => {
  expect(answer.status, `${name} ${JSON.stringify(answer.body)}`).toBe(200);
  return answer.body;
};

/** Bravo's manager, holding what alpha's does, and an agent login of its own. */
async function installBravo(
  controls: Controls,
  bravo: string,
): Promise<{ readonly manager: Member; readonly agent: string }> {
  const { db } = controls.fixture;
  const manager = await enrol(db.app, bravo, 'bravomanager');
  const agent = `agent-${randomUUID()}`;
  await db.app.withBusiness(bravo, async (tx) => {
    for (const action of ['read', 'write', 'decide', 'assign', 'comment', 'manage'] as const) {
      // eslint-disable-next-line no-await-in-loop -- a grant reads the granter's own rows
      await grantTo(tx, manager, action);
    }
    await tx.query(
      `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
       values ($1, $2, 'local', 500000, 'AUD')`,
      [bravo, randomUUID()],
    );
    const actorId = randomUUID();
    await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      bravo,
      actorId,
    ]);
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [bravo, randomUUID(), await insertLogin(tx, agent), actorId, manager.actorId],
    );
  });
  return { manager, agent };
}

/** A person's call on bravo's routes, which must succeed. */
async function callerOf(controls: Controls, member: Member) {
  const token = await tokenFor(member.presented.subject);
  return async (name: string, body: object): Promise<Record<string, unknown>> =>
    must(
      await post(
        controls.api,
        `/api/b/bravo/${name.replace('.', '/')}`,
        { operationId: randomUUID(), ...body },
        authorised(token),
      ),
      name,
    );
}

/** One picked-up run in bravo through bravo's routes, its calls seeded by `seed`. */
export async function runInBravo(
  controls: Controls,
  bravo: string,
  canary: string,
  seed: (ran: Ran, picked: Record<string, unknown>) => Promise<void>,
): Promise<Ran> {
  const { manager, agent } = await installBravo(controls, bravo);
  const asManager = await callerOf(controls, manager);
  const task = await asManager('task.create', { fields: { title: `bravo ${canary}` } });
  const proposal = detail(
    await asManager('task.propose', {
      recordId: task['recordId'],
      expectedRevision: task['revision'],
      ...PROPOSAL,
    }),
  );
  const decided = await asManager('task.decide', {
    gateId: proposal['gateId'],
    versionId: proposal['versionId'],
    decision: 'approve',
    note: 'approved so an agent can work it',
  });
  const picked = detail(
    must(
      await post(
        controls.api,
        '/api/a/b/bravo/task/pickup',
        { operationId: randomUUID(), reservationId: detail(decided)['reservationId'] },
        authorised(await tokenFor(agent)),
      ),
      'task.pickup',
    ),
  );
  const [run] = await controls.fixture.db.admin.execute<{ readonly run_id: string }>(
    `select run_id from public.leases where business_id = $1 and id = $2`,
    [bravo, picked['leaseId']],
  );
  const ran = { runId: String(run?.run_id), taskId: String(task['recordId']) };
  await seed(ran, picked);
  return ran;
}
