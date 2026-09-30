// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-05's answers, part 2: the grant is rechecked under the lock. An answer
// checks the grant, then waits for its locks; a grant that lapses while it
// waits no longer counts when the answer is decided, and nothing is written.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { endAtBudgetStop } from '../../packages/core-runtime/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { asAgent, codeOf, racer } from '../runtime/schedules-harness.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { as, moneyOf, one, stopped, usePeople } from './budget-answers-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('aw05races');
usePeople();

/** A person whose `gate:decide` ends two seconds from now. */
async function lapsing(): Promise<Member> {
  const member = await enrol(s.db.app, s.business, 'lapsing');
  const grantId = await s.db.app.withBusiness(
    s.business,
    async (tx) => await grantTo(tx, member, 'decide', undefined, false, 'gate'),
  );
  await s.db.admin.execute(
    `update public.grants set expires_at = now() + interval '2 seconds' where id = $1`,
    [grantId],
  );
  return member;
}

it('AW-05 a grant that lapses while the answer waits on its locks is refused under them', async () => {
  const { runId } = await stopped('aw05 grant lapses');
  const member = await lapsing();
  const before = await moneyOf(runId);
  const { cap_id: capId } = await one<{ cap_id: string }>(
    `select e.cap_id from public.reservations r
       join public.task_envelopes e on e.id = r.envelope_id where r.run_id = $1`,
    [runId],
  );
  const holder = racer(s);
  const answerer = racer(s);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    // The cap is the first lock an answer takes: hold it past the grant's end.
    const holding = holder.withBusiness(s.business, async (tx) => {
      await tx.query(`select id from public.budget_caps where id = $1 for update`, [capId]);
      await held;
    });
    const answer = answerer.withBusiness(
      s.business,
      async (tx) => await endAtBudgetStop(tx, as(member, runId)),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 2500);
    });
    release();
    await holding;
    const answered = await answer;
    expect(answered.ok ? 'applied' : answered.refusal.code).toBe('SCOPE_NOT_GRANTED');
  } finally {
    await holder.close();
    await answerer.close();
  }
  expect(await moneyOf(runId)).toEqual(before);
});

it('AW-05 a pickup of a waiting run is refused and moves nothing', async () => {
  const { work, runId } = await stopped('aw05 pickup while waiting');
  const before = await moneyOf(runId);
  const result = await asAgent(s, {
    command: 'task.pickup',
    operationId: randomUUID(),
    reservationId: work.decision['reservationId'],
    leaseSeconds: 600,
  });
  expect(codeOf(result)).toBe('RESERVATION_NOT_CLAIMABLE');
  expect(await moneyOf(runId)).toEqual(before);
});
