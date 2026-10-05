// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { callModelForPlanning, sweepModelCalls } from '../../packages/core-custody/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { asPerson, codeOf, seedSchedules } from '../runtime/schedules-harness.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import { s, useBrokerWorld, world, gated } from './broker-world.ts';
import { allowance, ask, local, ownerOf, rowsFor, setCap } from './aw-04-planning-world.ts';
import { randomUUID } from 'node:crypto';

useBrokerWorld('lateplanning');

const noop = (): void => undefined;

type Seeded = Awaited<ReturnType<typeof seedSchedules>>;

/** The app database, its second transaction held until `resume`; `readyPromise` settles when it is held. */
function delayedSecondTransaction(on: Seeded): {
  readonly delayed: Database;
  readonly readyPromise: Promise<void>;
  readonly resume: () => void;
} {
  let ready = noop;
  let resume = noop;
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const resumePromise = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let transactions = 0;
  const delayed: Database = {
    ...on.db.app,
    withBusiness: async (businessId, run) => {
      transactions += 1;
      if (transactions === 2) {
        // The real provider has answered; its settlement transaction is delayed.
        ready();
        await resumePromise;
      }
      return await on.db.app.withBusiness(businessId, run);
    },
  };
  return { delayed, readyPromise, resume: () => resume() };
}

/** The sweep holds the dispatched call unknown and its owner records nothing happened. */
async function releaseByOwner(on: Seeded, conversationId: string, callId: unknown): Promise<void> {
  // Advance the persisted age, without changing state, to exercise the real sweep.
  await on.db.admin.execute(
    `update public.model_calls
    set accepted_at = clock_timestamp() - interval '11 minutes',
        started_at = clock_timestamp() - interval '11 minutes'
    where id = $1`,
    [callId],
  );
  await on.db.app.withBusiness(on.business, async (tx) => await sweepModelCalls(tx));
  expect(
    codeOf(
      await asPerson(on, {
        command: 'budget.record_outcome',
        operationId: randomUUID(),
        recordId: conversationId,
        attemptId: callId,
        outcome: 'nothing_happened',
      }),
    ),
  ).toBe('applied');
  expect(await rowsFor(on, conversationId)).toMatchObject([
    { state: 'released', outcome: 'nothing_happened' },
  ]);
  expect((await allowance(on, on.decider.personId, conversationId)).leftMinor).toBe(500);
}

/** The planning spend committed across the business's model calls. */
async function committedMinor(on: Seeded): Promise<number> {
  const [cap] = await on.db.admin.execute<{ committed: string }>(
    `select sum(case
    when state = 'settled' then actual_minor
    when state in ('reserved', 'dispatched', 'liability_unknown') then reserved_minor else 0 end)::text as committed
    from public.model_calls where business_id = $1`,
    [on.business],
  );
  return Number(cap?.committed);
}

it('a delayed planning settlement cannot spend a hold already released by its owner', async () => {
  const on = await seedSchedules(s.db, 'lateplanningowner', 1_000_000);
  await openBilling(on);
  await setCap(on, 500);
  world.provider.mode('answer');
  const request = ask(on);
  const { delayed, readyPromise, resume } = delayedSecondTransaction(on);
  const first = callModelForPlanning(delayed, on.business, ownerOf(on), request, local(on));
  await readyPromise;
  const [original] = await rowsFor(on, request.conversation.id);
  expect(original).toMatchObject({ state: 'dispatched' });
  await releaseByOwner(on, request.conversation.id, original?.['id']);
  // Another reply takes the released room, and remains in flight at its maximum.
  const secondRequest = ask(on);
  const slow = gated(local(on));
  const second = callModelForPlanning(
    on.db.app,
    on.business,
    ownerOf(on),
    secondRequest,
    slow.broker,
  );
  try {
    await expect
      .poll(async () => (await rowsFor(on, secondRequest.conversation.id))[0]?.['state'])
      .toBe('dispatched');
    resume();
    await first;
    const [old] = await rowsFor(on, request.conversation.id);
    const committed = await committedMinor(on);
    expect(
      { state: old?.['state'], committed },
      'the delayed reply must respect the recorded release and the now occupied cap',
    ).toEqual({ state: 'released', committed: 500 });
  } finally {
    resume();
    slow.open();
    await Promise.allSettled([first, second]);
  }
});
