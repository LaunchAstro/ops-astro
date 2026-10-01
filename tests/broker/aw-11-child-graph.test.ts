// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-11 on the execution graph: a helper's work sits under its parent's run.
// Each helper handed part of the run's work is an entry on the run's node,
// with its state (working, handed back, dropped), its outcome and named
// refusal, the fault a drop names, and its own steps: the model calls it made
// on the parent's lease, which spend the parent's one reservation. When the
// parent's lease runs out the helper's next call refuses, the work comes back,
// and a replacement parent picks it up and hands a new helper the work; the
// old helper is never resumed.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { resolveDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { REPLAY_COMPOSE } from '../../packages/core-connectors/src/index.ts';
import { sweepLostWorkers } from '../../packages/core-runtime/src/index.ts';
import { readAsHelper, callCode, updateRaw } from '../runtime/aw-11-child-world.ts';
import { handBack } from '../runtime/aw-11-child-work-world.ts';
import {
  approve,
  codeOf,
  createTask,
  freshPurpose,
  pickup,
  propose,
  rows,
  waitPast,
  type Work,
} from '../runtime/schedules-harness.ts';
import { callOn, noDatabase, useSpendWorld, w } from './aw-11-spend-world.ts';
import { handedWork, handOver, nodeOf } from './aw-11-child-graph-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useSpendWorld('aw11cg');

it('AW-11 child steps under the parent: the helper’s calls sit on the parent’s node, on one ceiling', async () => {
  const x = await handedWork(w.s, w.helper);
  expect(codeOf(await callOn(w.s, x.work, w.s.agent, x.parentCredential))).toBe('applied');
  for (let n = 0; n < 2; n += 1) {
    // Sequential: each call holds the parent's reservation under its locks.
    // oxlint-disable-next-line no-await-in-loop
    const called = await callOn(w.s, x.work, w.helper.presented, x.childCredential);
    expect(codeOf(called)).toBe('applied');
  }
  const node = await nodeOf(w.s, x.work);
  expect(node?.helpers).toHaveLength(1);
  const [helper] = node?.helpers ?? [];
  expect(helper).toMatchObject({
    childDelegationId: x.childId,
    helperActorId: w.helper.actorId,
    state: 'working',
    outcome: null,
    refusal: null,
    fault: null,
  });
  // The helper's two calls, and never the parent's own.
  expect(helper?.steps.map((step) => [step.operation, step.state])).toStrictEqual([
    [REPLAY_COMPOSE.key, 'settled'],
    [REPLAY_COMPOSE.key, 'settled'],
  ]);
  // One ceiling: the helper's spend is part of what the parent's reservation carries.
  const [ledger] = await rows<{ readonly spent: string; readonly reservations: string }>(
    w.s,
    `select sum(actual_minor)::text as spent, count(distinct reservation_id)::text as reservations
       from public.model_calls where business_id = $1 and lease_id = $2`,
    [w.s.business, x.work.picked['leaseId']],
  );
  expect(ledger?.reservations).toBe('1');
  const helperSpent = helper?.steps.reduce((sum, step) => sum + (step.spentMinor ?? 0), 0) ?? 0;
  expect(helper?.spentMinor).toBe(helperSpent);
  expect(helperSpent).toBeGreaterThan(0);
  expect(helperSpent).toBeLessThan(Number(ledger?.spent));
  expect(node?.observed['heldMinor']).toBe(2_000);
});

it('AW-11 a helper’s handback shows under the parent with its outcome and named refusal', async () => {
  const x = await handedWork(w.s, w.helper);
  const back = await handBack(w.s, w.helper, x.childCredential, {
    outcome: 'partial',
    refusal: 'BUDGET_UNAVAILABLE',
  });
  expect(back.ok).toBe(true);
  expect((await nodeOf(w.s, x.work))?.helpers).toMatchObject([
    {
      childDelegationId: x.childId,
      state: 'handed_back',
      outcome: 'partial',
      refusal: 'BUDGET_UNAVAILABLE',
      fault: null,
    },
  ]);
});

it('AW-11 child drops: the parent waits with the helper’s fault shown, and nothing re-delegates', async () => {
  const x = await handedWork(w.s, w.helper);
  expect(
    await updateRaw(w.s, x.childId, `revoked_at = now(), revocation_cause = 'delegation_revoked'`),
  ).toBe('updated');
  expect(callCode(await readAsHelper(w.s, w.helper, x.childCredential, x.work.taskId))).toBe(
    'DELEGATION_NOT_LIVE',
  );
  const node = await nodeOf(w.s, x.work);
  expect(node?.helpers).toMatchObject([
    { childDelegationId: x.childId, state: 'dropped', fault: 'DELEGATION_REVOKED', outcome: null },
  ]);
  // The parent's run is still its own: in progress, its lease live.
  expect(node?.observed).toMatchObject({ condition: 'in_progress', fault: null });
});

it('AW-11 replacement parent delegates a new child: the old helper is never resumed', async () => {
  const taskId = await createTask(w.s, `aw-11 replacement ${randomUUID()}`);
  const proposal = await propose(w.s, taskId, { maximumMinor: 2_000, purpose: freshPurpose() });
  const decision = await approve(w.s, proposal);
  const first = await pickup(w.s, decision['reservationId'], 2);
  const work: Work = { taskId, proposal, decision, picked: first };
  const parent = await resolved(String(first['credential']));
  const old = await handOver(w.s, parent, work, w.helper);

  // The parent's lease runs out; the sweep names the lost worker and brings the work back.
  await waitPast(w.s, `select expires_at from public.leases where id = $1`, first['leaseId']);
  await w.s.db.app.withBusiness(w.s.business, async (tx) => await sweepLostWorkers(tx));
  // The child ran out with the lease it was capped at (`delegateChild`), so its
  // own credential is dead: DELEGATION_NOT_LIVE, as any run-out credential is.
  // The graph names the fault the walk reads first, DELEGATION_EXPIRED.
  expect(callCode(await readAsHelper(w.s, w.helper, old.childCredential, taskId))).toBe(
    'DELEGATION_NOT_LIVE',
  );

  // A replacement parent picks the work up again and hands a new helper the work.
  const [back] = await rows<{ readonly id: string }>(
    w.s,
    `select id from public.reservations
      where business_id = $1 and run_id = $2 and state = 'held' and lease_id is null`,
    [w.s.business, first['runId']],
  );
  const again = await pickup(w.s, back?.id);
  expect(again['runId']).toBe(first['runId']);
  const replacement = await resolved(String(again['credential']));
  expect(replacement.id).not.toBe(parent.id);
  const renewed: Work = { ...work, picked: again };
  const fresh = await handOver(w.s, replacement, renewed, w.helper);
  expect(fresh.childId).not.toBe(old.childId);

  // The old credential stays refused; the new one reads the task.
  expect(callCode(await readAsHelper(w.s, w.helper, old.childCredential, taskId))).toBe(
    'DELEGATION_NOT_LIVE',
  );
  expect(callCode(await readAsHelper(w.s, w.helper, fresh.childCredential, taskId))).toBe(
    'applied',
  );
  const node = await nodeOf(w.s, renewed);
  expect(node?.helpers).toMatchObject([
    { childDelegationId: old.childId, state: 'dropped', fault: 'DELEGATION_EXPIRED' },
    { childDelegationId: fresh.childId, state: 'working', fault: null },
  ]);
});

async function resolved(credential: string) {
  const found = await w.s.db.app.withBusiness(
    w.s.business,
    async (tx) => await resolveDelegation(tx, w.s.agentActorId, credential),
  );
  if (!found.ok) throw new Error(`the parent did not resolve: ${found.refusal.code}`);
  return found.value;
}
