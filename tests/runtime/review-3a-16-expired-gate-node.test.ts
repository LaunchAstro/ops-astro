// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-3A-16: a gate past its deadline must read `settled` with outcome
// `expired` on the execution graph (docs/local/API.md, `task.execution`'s
// observed layer). Expiry is derived on read and never written: the stored
// `gates.state` stays `pending` (owner decision of 23 September 2026,
// `reads/proposals.ts`). The graph's run facts read that stored state
// (`reads/execution.ts`, `'gateState', gate.state`), so `SETTLED_BY_GATE`
// never sees `expired` and the run reads `not_started`, offering a decision
// `task.decide` refuses `GATE_EXPIRED`.
//
// Fixed when the run facts derive the gate's state the way `task.read` does:
// a pending gate with `expires_at <= now()` reads `expired`.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it as vitestIt } from 'vitest';
import {
  appliedDetail,
  asPerson,
  createTask,
  freshPurpose,
  proposeBody,
  revisionOf,
  rows,
} from './schedules-harness.ts';
import { graphAs, nodeOf, noDatabase, useAw06World, w } from './aw-06-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useAw06World('review3a16');

/** Wait until the database's own clock is past the gate's deadline. */
async function untilExpired(gateId: unknown): Promise<void> {
  for (let tries = 0; tries < 40; tries += 1) {
    // eslint-disable-next-line no-await-in-loop -- polling the database clock
    const [row] = await rows<{ readonly past: boolean }>(
      w.s,
      `select (expires_at <= now()) as past from public.gates where business_id = $1 and id = $2`,
      [w.s.business, gateId],
    );
    if (row?.past === true) return;
    // eslint-disable-next-line no-await-in-loop -- as above
    await sleep(250);
  }
  throw new Error('the gate never passed its deadline on the database clock');
}

it('REVIEW-3A-16: a pending gate past its deadline reads settled/expired on the execution graph, not not_started', async () => {
  const taskId = await createTask(w.s, `review-3a-16-${randomUUID()}`);
  const body = proposeBody(taskId, await revisionOf(w.s, taskId), {
    maximumMinor: 500,
    purpose: freshPurpose(),
  });
  const proposal = appliedDetail(
    await asPerson(w.s, { ...body, expiresInSeconds: 1 }),
    'task.propose',
  );
  await untilExpired(proposal['gateId']);

  // The stored record is unchanged: expiry is derived on read.
  const [stored] = await rows<{ readonly state: string }>(
    w.s,
    `select state from public.gates where business_id = $1 and id = $2`,
    [w.s.business, proposal['gateId']],
  );
  expect(stored?.state).toBe('pending');

  const [run] = await rows<{ readonly id: string }>(
    w.s,
    `select id::text as id from public.planned_runs where business_id = $1 and version_id = $2`,
    [w.s.business, proposal['versionId']],
  );
  const node = nodeOf(await graphAs(w.s.decider, taskId), run?.id);
  expect(node.condition, 'an expired gate reads as a run not yet started').toBe('settled');
  expect(node.observed).toMatchObject({
    condition: 'settled',
    outcome: 'expired',
    whoseMove: null,
  });
});
