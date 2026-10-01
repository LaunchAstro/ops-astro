// SPDX-License-Identifier: AGPL-3.0-only
//
// `AW-08 client sign-off`: where the business requires the client's sign-off
// (`client_sign_off_required`), agency approval alone never releases the
// effect. The launch cannot decide, and a setting turned on after the launch
// is seen by the effect-time recheck, a change in flight included. Both refuse
// `CLIENT_SIGNOFF_REQUIRED` with nothing written or marked. The client's own
// sign-off is MP-11-5's (phase 8); before the portal exists the work stays held.
// The plan accept is not the launch, so it still decides under the setting.

import { expect, it as vitestIt } from 'vitest';
import { acceptAs, acceptRequest, gateOf, noDatabase, useAw04World, w } from './aw-04-world.ts';
import { approveBody, asPerson, barrier, codeOf, racer, rows } from './schedules-harness.ts';
import { dispatchAs, leased, marked, proposedEffect, setSignOff } from './aw-08-gate-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useAw04World('aw08sign');

it('AW-08 client sign-off: where the business requires it, the launch cannot decide: CLIENT_SIGNOFF_REQUIRED and nothing written', async () => {
  await setSignOff(w.alpha, true);
  try {
    const proposal = await proposedEffect(w.alpha);
    const answer = await asPerson(w.alpha, approveBody(proposal));
    expect(codeOf(answer)).toBe('CLIENT_SIGNOFF_REQUIRED');
    expect(await gateOf(w.alpha, proposal['gateId'])).toStrictEqual({
      state: 'pending',
      decisions: '0',
    });
    const held = await rows<{ n: string }>(
      w.alpha,
      'select count(*)::text as n from public.reservations where business_id = $1 and version_id = $2',
      [w.alpha.business, proposal['versionId']],
    );
    expect(held[0]?.n).toBe('0');
  } finally {
    await setSignOff(w.alpha, false);
  }
});

it('AW-08 client sign-off: agency approval alone never releases the effect: required after the launch, dispatch refuses and marks nothing', async () => {
  const work = await leased(w.alpha, 'launch');
  await setSignOff(w.alpha, true);
  try {
    expect(codeOf(await dispatchAs(w.alpha, work))).toBe('CLIENT_SIGNOFF_REQUIRED');
    expect(await marked(w.alpha, work.taskId)).toBe(0);
  } finally {
    await setSignOff(w.alpha, false);
  }
  // Control: with the setting off again the same lease dispatches.
  expect(codeOf(await dispatchAs(w.alpha, work))).toBe('applied');
});

it('AW-08 client sign-off: a setting change in flight is waited for at dispatch and then seen', async () => {
  const work = await leased(w.alpha, 'launch');
  await setSignOff(w.alpha, false);
  const rival = racer(w.alpha);
  const { held, release } = barrier();
  const locked = barrier();
  try {
    const turning = rival.withBusiness(w.alpha.business, async (tx) => {
      await tx.query(
        `update public.business_settings set value = 'true'::jsonb
          where business_id = $1 and key = 'client_sign_off_required'`,
        [w.alpha.business],
      );
      locked.release();
      await held;
    });
    await locked.held;
    const dispatching = dispatchAs(w.alpha, work);
    // Bounded: a dispatch that never waits on the setting is answered below.
    for (let tries = 0; tries < 80; tries += 1) {
      // eslint-disable-next-line no-await-in-loop
      const waiting = await rows<{ n: string }>(
        w.alpha,
        `select count(*)::text as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
        [],
      );
      if (Number(waiting[0]?.n) > 0) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    await turning;
    expect(codeOf(await dispatching)).toBe('CLIENT_SIGNOFF_REQUIRED');
    expect(await marked(w.alpha, work.taskId)).toBe(0);
  } finally {
    release();
    await rival.close();
    await setSignOff(w.alpha, false);
  }
}, 30_000);

it('AW-08 client sign-off: the plan accept is not the launch, so it still decides under the setting', async () => {
  await setSignOff(w.alpha, true);
  try {
    const proposal = await proposedEffect(w.alpha);
    const accepted = await acceptAs(
      w.alpha,
      acceptRequest(w.alpha, { taskId: proposal.taskId, proposal }),
    );
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
  } finally {
    await setSignOff(w.alpha, false);
  }
});
