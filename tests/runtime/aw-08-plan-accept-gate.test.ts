// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04's invariant, `plan_accept_is_not_an_effect_gate`, rerun at AW-08's
// head against the launch gate. The plan accept is `task.accept_plan`, the
// drawer's one click: it approves the plan's gate, binds the plan and pins the
// entry file, and lets the agent work. It is not an effect gate: a dispatch
// under the plan's lease is refused `LAUNCH_NOT_DECIDED`, marks nothing and
// leaves the plan's version unmarked. The reviewed output's launch is the
// positive control.

import { expect, it as vitestIt } from 'vitest';
import {
  acceptBody,
  noDatabase,
  planRecordsOf,
  useAw04World,
  useInstructionRoot,
  w,
} from './aw-04-world.ts';
import { dispatchBody, handBack, marked, marksOf, proposeEffect } from './aw-08-world.ts';
import {
  appliedDetail,
  approve,
  asAgent,
  asPerson,
  codeOf,
  pickup,
  rows,
} from './schedules-harness.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useAw04World('aw08_plan_gate');
useInstructionRoot();

it('plan_accept_is_not_an_effect_gate: the plan accept lets the agent work and releases no effect', async () => {
  const s = w.alpha;
  const { taskId, plan } = await proposeEffect(s, 'aw08 plan gate');
  const accepted = appliedDetail(
    await asPerson(s, acceptBody({ taskId, proposal: plan })),
    'task.accept_plan',
  );
  expect(await planRecordsOf(s, plan['gateId'])).toHaveLength(1);
  const working = await pickup(s, accepted['reservationId']);

  const refused = await asAgent(s, dispatchBody(working), String(working['credential']));
  expect(codeOf(refused), 'the plan accept released the effect').toBe('LAUNCH_NOT_DECIDED');
  expect(JSON.stringify(refused)).not.toContain(String(working['credential']));
  expect(await marked(s, taskId)).toBe(0);
  expect(await marksOf(s, taskId)).toEqual([]);
  const attempts = await rows<{ dispatch_marker: boolean }>(
    s,
    `select a.dispatch_marker from public.attempts a
      where a.business_id = $1 and a.reservation_id = $2`,
    [s.business, accepted['reservationId']],
  );
  expect(attempts).toEqual([{ dispatch_marker: false }]);

  // Control: the output handed back is the reviewed output, and its accept launches.
  const handedBack = await handBack(s, working);
  expect(await marksOf(s, taskId)).toEqual([handedBack['successorVersionId']]);
  const launch = await approve(s, {
    gateId: handedBack['successorGateId'],
    versionId: handedBack['successorVersionId'],
  });
  const picked = await pickup(s, launch['reservationId']);
  appliedDetail(await asAgent(s, dispatchBody(picked), String(picked['credential'])), 'dispatch');
  expect(await marked(s, taskId)).toBe(1);
});
