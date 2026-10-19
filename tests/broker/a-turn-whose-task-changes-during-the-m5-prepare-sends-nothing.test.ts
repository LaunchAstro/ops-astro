// SPDX-License-Identifier: AGPL-3.0-only
//
// The carried send binds a turn again (#2091, gap 3): the agent's turn on the
// owner's plan names its task at a revision, and the hosted side's judgement
// after the model agent's prepare binds that part afresh, as the start does.
// An agent write that makes the task outside, or any write that moves its
// revision, committed while the model agent prepares, sends nothing; so does a
// client linked during the send fence's wait. With nothing changed, the same
// turn is sent.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { liveWork, type Work } from '../runtime/schedules-harness.ts';
import { rowsOf, s, useBrokerWorld } from './broker-world.ts';
import { openCarriedTaskWorld, type CarriedTaskWorld } from './carried-task-world.ts';
import { carriedTurn } from './carried-turn-world.ts';

const serverUrl = databaseUrlFromEnvironment();

useBrokerWorld('turnwait');

const fresh = async (title: string): Promise<Work> =>
  await liveWork(s, `${title} ${randomUUID()}`, 2_000);

// oxlint-disable-next-line max-lines-per-function -- one world, three changes and the control
describe.skipIf(serverUrl === undefined)('a turn whose task changes in the M5 wait', () => {
  let world: CarriedTaskWorld;

  beforeAll(async () => {
    world = await openCarriedTaskWorld();
  }, 180_000);

  afterAll(async () => {
    await world?.close();
  });

  /** The work's first turn, with `change` committed in the wait `at` names; what was sent. */
  async function turnWith(
    work: Work,
    at: 'duringPrepare' | 'duringFence',
    change: () => Promise<void>,
  ) {
    let ran = false;
    world[at] = async () => {
      if (ran) return;
      ran = true;
      await change();
    };
    const sent = world.plan.sent.length;
    try {
      const answer = await carriedTurn(world, work);
      const [row] = await rowsOf(answer.callId);
      return { answer, ran, sent: world.plan.sent.length - sent, state: row?.['state'] };
    } finally {
      world[at] = async () => {};
    }
  }

  it('sends nothing when an agent write makes the task outside during the prepare', async () => {
    const work = await fresh('Made outside mid-prepare');
    const called = await turnWith(work, 'duringPrepare', async () => {
      await s.db.admin.execute(
        `insert into public.operations (business_id, id, operation_id, actor_id, command, record_id,
                                        outcome, payload_digest, result)
         values ($1, gen_random_uuid(), $2, $3, 'task.update', $4, 'applied', repeat('0', 64), '{}')`,
        [s.business, randomUUID(), s.agentActorId, work.taskId],
      );
    });
    expect(called).toMatchObject({ ran: true, sent: 0, state: 'released' });
    expect(called.answer).toMatchObject({
      ok: false,
      code: 'CALL_RELEASED',
      reason: 'LOCAL_MODEL_REQUIRED',
    });
  }, 60_000);

  it("sends nothing when the task's revision moves during the prepare", async () => {
    const work = await fresh('Revised mid-prepare');
    const called = await turnWith(work, 'duringPrepare', async () => {
      await s.db.admin.execute(
        `update public.records set revision = revision + 1 where business_id = $1 and id = $2`,
        [s.business, work.taskId],
      );
    });
    expect(called).toMatchObject({ ran: true, sent: 0, state: 'released' });
    expect(called.answer).toMatchObject({
      ok: false,
      code: 'CALL_RELEASED',
      reason: 'PROVENANCE_UNBOUND',
    });
  }, 60_000);

  it('sends nothing when a client is linked to the task during the fence wait', async () => {
    const work = await fresh('Client link mid-fence');
    const client = randomUUID();
    const called = await turnWith(work, 'duringFence', async () => {
      await s.db.admin.execute(
        `update public.records set data = data || jsonb_build_object('client', $2::text)
          where business_id = $3 and id = $1`,
        [work.taskId, client, s.business],
      );
    });
    expect(called).toMatchObject({ ran: true, sent: 0 });
    expect(called.answer).toMatchObject({ ok: false });
    expect(JSON.stringify(called.answer)).not.toContain(client);
  }, 60_000);

  it('control: with nothing changed during the prepare, the turn is sent and settles', async () => {
    const work = await fresh('Nothing changed mid-prepare');
    const called = await turnWith(work, 'duringPrepare', async () => {
      await sleep(200);
    });
    expect(called).toMatchObject({ ran: true, sent: 1, state: 'settled' });
    expect(called.answer).toMatchObject({ ok: true });
  }, 60_000);
});
