// SPDX-License-Identifier: AGPL-3.0-only
//
// The evidence that a step reached its provider is written once. A marked
// step whose worker recorded its provider start, and whose silent broker call
// the provider then proved absent, stays unanswered: the call's absence says
// nothing about the step's own provider. The pass reads that from the
// attempt's `provider_started_at` and `drop_cause`, and from the held calls'
// `drop_cause`, so an application writer that cleared or rewrote any of them
// would turn "cannot answer" into "nothing happened" and admit replacement
// work. Each such write is refused, and the pass still leaves the step whole.

import { expect, it as vitestIt } from 'vitest';
import { REPLAY_PATH } from '../../packages/core-connectors/src/index.ts';
import {
  attemptsOf,
  callsOf,
  dropped,
  noDatabase,
  pass,
  s,
  useFaultWorld,
  workerLost,
  world,
} from './aw-10-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useFaultWorld('aw10evidence');

/** One update as the application, which holds `update` on both tables. */
const asApp = async (text: string, parameters: readonly unknown[]): Promise<unknown> =>
  await s.db.app.withBusiness(s.business, async (tx) => await tx.query(text, parameters));

/** The silent call reaches the provider while it is down, which refuses it before any work. */
const refusedBeforeWork = async (work: Awaited<ReturnType<typeof workerLost>>): Promise<void> => {
  world.provider.mode('unavailable');
  const [call] = await callsOf(s, work);
  await fetch(`${world.provider.origin}${REPLAY_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation_id: String(call?.['id']) }),
  }).then(async (response) => await response.text());
};

it("a step's provider start cannot be cleared by the application, so the pass keeps it unanswered and its hold whole", async () => {
  world.provider.lookupMode('honest');
  const work = await workerLost(s, true);
  const attemptId = work.picked['attemptId'];
  await refusedBeforeWork(work);
  await pass();
  expect(await callsOf(s, work)).toMatchObject([{ state: 'released', outcome: null }]);

  await expect(
    asApp(
      `update public.attempts set provider_started_at = null where business_id = $1 and id = $2`,
      [s.business, attemptId],
    ),
  ).rejects.toMatchObject({ code: '23001' });
  await expect(
    asApp(
      `update public.attempts set provider_started_at = provider_started_at - interval '1 hour'
        where business_id = $1 and id = $2`,
      [s.business, attemptId],
    ),
  ).rejects.toMatchObject({ code: '23001' });

  const swept = await pass();
  const reconciled = swept.ok ? (swept.businesses[0]?.reconciled ?? []) : [];
  expect(reconciled.filter((one) => one.attemptId === attemptId)).toMatchObject([
    { answer: 'unanswered' },
  ]);
  expect(await attemptsOf(s, work)).toMatchObject([
    { state: 'abandoned' },
    { id: attemptId, state: 'liability_unknown', marked: true, held: 'held' },
  ]);
});

it("a drop's cause cannot be cleared or rewritten on the attempt or on its held call", async () => {
  const { work } = await dropped('cut');
  const [attempt] = await attemptsOf(s, work);
  const [call] = await callsOf(s, work);
  expect(attempt).toMatchObject({ drop_cause: 'connection_lost' });
  expect(call).toMatchObject({ drop_cause: 'connection_lost' });

  for (const cause of [null, 'provider_unavailable']) {
    // eslint-disable-next-line no-await-in-loop
    await expect(
      asApp(`update public.attempts set drop_cause = $3 where business_id = $1 and id = $2`, [
        s.business,
        attempt?.['id'],
        cause,
      ]),
      `attempt to ${String(cause)}`,
    ).rejects.toMatchObject({ code: '23001' });
    // eslint-disable-next-line no-await-in-loop
    await expect(
      asApp(`update public.model_calls set drop_cause = $3 where business_id = $1 and id = $2`, [
        s.business,
        call?.['id'],
        cause,
      ]),
      `call to ${String(cause)}`,
    ).rejects.toMatchObject({ code: '23001' });
  }
  expect(await attemptsOf(s, work)).toMatchObject([{ drop_cause: 'connection_lost' }]);
  expect(await callsOf(s, work)).toMatchObject([{ drop_cause: 'connection_lost' }]);
});
