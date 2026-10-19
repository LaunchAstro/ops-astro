// SPDX-License-Identifier: AGPL-3.0-only
//
// The send fence of a carried task call (#1703, #1620 P5) holds its locks
// through the send: once the send judgement has passed, a client linked to
// the task, or the lease handed back, from another connection, waits until
// the send is written and the fence lets go. Neither can commit between the
// judgement and the send, so what the judgement saw is what the send carried.
// A handback that waited is then refused while the sent call is unsettled
// (#1623 R2), so the call's answer still reaches the lease that sent it.
// Each change runs on its own connection: the admin's for the client link, a
// second application pool for the handback.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { asAgent, handbackBody, liveWork, type Work } from '../runtime/schedules-harness.ts';
import { rowsOf, s, useBrokerWorld } from './broker-world.ts';
import { carriedCall, openCarriedTaskWorld, type CarriedTaskWorld } from './carried-task-world.ts';

const serverUrl = databaseUrlFromEnvironment();

/** How long the change is given to commit while the fence holds. */
const HELD_MS = 500;

useBrokerWorld('carryfence');

const fresh = async (title: string): Promise<Work> =>
  await liveWork(s, `${title} ${randomUUID()}`, 2_000);

// oxlint-disable-next-line max-lines-per-function -- one world, two connections
describe.skipIf(serverUrl === undefined)('the send fence of a carried task call', () => {
  let world: CarriedTaskWorld;
  let second: Database;

  beforeAll(async () => {
    world = await openCarriedTaskWorld();
    second = connect(s.db.appUrl, { source: 'runtime', log: s.db.log });
  }, 180_000);

  afterAll(async () => {
    await second?.close();
    await world?.close();
  });

  /** The work's call with `change` started on another connection while the fence holds; the order seen. */
  async function callWith(work: Work, change: () => Promise<unknown>) {
    const order: string[] = [];
    let changing: Promise<unknown> = Promise.resolve();
    world.duringFence = async () => {
      changing = change().then((result) => {
        order.push('change committed');
        return result;
      });
      await sleep(HELD_MS);
      order.push('fence about to let go');
    };
    const sent = world.plan.sent.length;
    try {
      const answer = await carriedCall(world, work);
      const changed = await changing;
      const [row] = await rowsOf(answer.callId);
      return { answer, changed, order, sent: world.plan.sent.length - sent, state: row?.['state'] };
    } finally {
      world.duringFence = async () => {};
    }
  }

  it('holds a client link on another connection until the send is written', async () => {
    const work = await fresh('Client link at the fence');
    const called = await callWith(
      work,
      async () =>
        await s.db.admin.execute(
          `update public.records set data = data || jsonb_build_object('client', $2::text)
            where id = $1`,
          [work.taskId, randomUUID()],
        ),
    );
    expect(called.order).toEqual(['fence about to let go', 'change committed']);
    expect(called).toMatchObject({ sent: 1, state: 'settled' });
    expect(called.answer).toMatchObject({ ok: true });
  }, 60_000);

  it('holds a handback on another connection until the send is written', async () => {
    const work = await fresh('Handback at the fence');
    const called = await callWith(
      work,
      async () =>
        await asAgent(s, handbackBody(work.picked), String(work.picked['credential']), second),
    );
    expect(called.changed).toMatchObject({
      refused: true,
      code: 'TRANSITION_NOT_PERMITTED',
      fixes: expect.arrayContaining(['a model call of this attempt has not settled']),
    });
    expect(called.order).toEqual(['fence about to let go', 'change committed']);
    expect(called).toMatchObject({ sent: 1, state: 'settled' });
    // The handback was refused, so the lease is still the caller's and its words reach it.
    expect(called.answer).toMatchObject({ ok: true });
    const after = await asAgent(
      s,
      handbackBody(work.picked),
      String(work.picked['credential']),
      second,
    );
    expect(after).toMatchObject({ command: 'task.handback' });
  }, 60_000);
});
