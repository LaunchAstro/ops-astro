// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-11: the helper's work, from its one-call pickup to the parent's merged
// result. The parent's holder hands part of its work over on its own lease
// and fence; the helper is handed everything it needs in one answer; the
// helper's result, or its partial work with the refusal that stopped it, lands
// on the parent's run; and a helper that drops is shown to the parent as a
// fault, never replaced on a guess.

import { expect, it as vitestIt } from 'vitest';
import { revokeDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { handBackChild } from '../../packages/core-runtime/src/index.ts';
import {
  awaitParked,
  barrier,
  racer,
  rows,
  type Schedules,
  type Work,
} from './schedules-harness.ts';
import {
  callCode,
  childRequest,
  noDatabase,
  parentWork,
  readAsHelper,
  updateRaw,
  useChildWorld,
  w,
} from './aw-11-child-world.ts';
import { codeOf, delegated, delegateOn, handBack, resultsOf } from './aw-11-child-work-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useChildWorld('aw11w');

async function childRows(on: Schedules, parentId: string): Promise<readonly { id: string }[]> {
  return await rows<{ id: string }>(
    on,
    `select id from public.delegations where business_id = $1 and parent_delegation_id = $2`,
    [on.business, parentId],
  );
}

async function eventsOn(
  on: Schedules,
  work: Work,
): Promise<readonly { kind: string; actor_id: string; detail: Record<string, unknown> }[]> {
  return await rows(
    on,
    `select kind, actor_id, detail from public.run_events
      where business_id = $1 and task_id = $2 order by position`,
    [on.business, work.taskId],
  );
}

it('AW-11 child pickup is one call: business, resource, approved version, operations, envelope, actor scope, bootstrap identity, declared incompleteness', async () => {
  const { work, parent } = await parentWork(w.s);
  const handed = await delegateOn(w.s, parent, work, childRequest(w.helper));
  if (!handed.ok) throw new Error(handed.refusal.code);
  const pickup = handed.value;
  expect(pickup).toMatchObject({
    businessId: w.s.business,
    resource: {
      taskId: work.taskId,
      runId: work.picked['runId'],
      leaseId: work.picked['leaseId'],
      fence: work.picked['fence'],
      reservationId: work.picked['reservationId'],
    },
    approvedVersion: {
      versionId: work.picked['versionId'],
      taskRevision: (work.picked['expectedVersions'] as { taskRevision: number }).taskRevision,
    },
    permittedOperations: ['task:read'],
    envelope: work.picked['budgetEnvelope'],
    actorScope: {
      agentActorId: w.helper.actorId,
      delegatePersonId: parent.delegatePersonId,
      purposeScope: { kind: 'record', id: work.taskId },
    },
    bootstrap: null,
  });
  expect(pickup.declaredIncompleteness.join(' ')).toMatch(/no pinned bootstrap file/u);
  // The credential it carries is the helper's, on the parent's task.
  expect(callCode(await readAsHelper(w.s, w.helper, pickup.credential, work.taskId))).toBe(
    'applied',
  );
  // The parent's run records the hand-over by handle, never the credential.
  const events = await eventsOn(w.s, work);
  const handedOver = events.find((event) => event.kind === 'delegated');
  expect(handedOver).toMatchObject({
    actor_id: parent.agentActorId,
    detail: { childDelegationId: pickup.childDelegationId, helperActorId: w.helper.actorId },
  });
  expect(JSON.stringify(events)).not.toContain(pickup.credential);
});

it('AW-11 child pickup binds the parent to its own lease, at its own fence', async () => {
  const mine = await parentWork(w.s);
  const other = await parentWork(w.s);
  // Another delegation presenting this lease, and this delegation at a fence
  // that is not the lease's: nothing is handed over.
  expect(codeOf(await delegateOn(w.s, other.parent, mine.work, childRequest(w.helper)))).toBe(
    'LEASE_NOT_OWNED',
  );
  expect(
    codeOf(
      await delegateOn(
        w.s,
        mine.parent,
        mine.work,
        childRequest(w.helper),
        Number(mine.work.picked['fence']) + 1,
      ),
    ),
  ).toBe('LEASE_NOT_OWNED');
  expect(await childRows(w.s, mine.parent.id)).toHaveLength(0);
  expect(await childRows(w.s, other.parent.id)).toHaveLength(0);
});

it('AW-11 child pickup never outlives the parent’s lease', async () => {
  const { work, parent } = await parentWork(w.s);
  const handed = await delegateOn(
    w.s,
    parent,
    work,
    childRequest(w.helper, { expiresAt: new Date(Date.now() + 24 * 3_600_000) }),
  );
  if (!handed.ok) throw new Error(handed.refusal.code);
  const [lease] = await rows<{ expires_at: Date }>(
    w.s,
    `select expires_at from public.leases where business_id = $1 and id = $2`,
    [w.s.business, work.picked['leaseId']],
  );
  expect(handed.value.actorScope.expiresAt.getTime()).toBeLessThanOrEqual(
    new Date(lease?.expires_at ?? 0).getTime(),
  );
});

it('AW-11 merged result: the helper’s completed work lands on the parent’s run, and its credential ends', async () => {
  const { work, parent, childId, credential } = await delegated(w.s, w.helper);
  expect(codeOf(await handBack(w.s, w.helper, credential, { outcome: 'completed' }))).toBe('ok');
  expect(await resultsOf(w.s, parent)).toEqual([
    {
      childDelegationId: childId,
      helperActorId: w.helper.actorId,
      state: 'handed_back',
      outcome: 'completed',
      refusal: null,
      fault: null,
    },
  ]);
  const merged = (await eventsOn(w.s, work)).find((event) => event.kind === 'child_handed_back');
  expect(merged).toMatchObject({
    actor_id: w.helper.actorId,
    detail: { childDelegationId: childId, outcome: 'completed', refusal: null },
  });
  expect(callCode(await readAsHelper(w.s, w.helper, credential, work.taskId))).toBe(
    'DELEGATION_NOT_LIVE',
  );
});

it('AW-11 revoked mid-child: the next call refuses, and the partial work reaches the parent with the refusal named', async () => {
  const { work, parent, childId, credential } = await delegated(w.s, w.helper);
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await revokeDelegation(tx, parent.id);
  });
  expect(callCode(await readAsHelper(w.s, w.helper, credential, work.taskId))).toBe(
    'DELEGATION_REVOKED',
  );
  expect(
    codeOf(
      await handBack(w.s, w.helper, credential, {
        outcome: 'partial',
        refusal: 'DELEGATION_REVOKED',
      }),
    ),
  ).toBe('ok');
  expect(await resultsOf(w.s, parent)).toMatchObject([
    {
      childDelegationId: childId,
      state: 'handed_back',
      outcome: 'partial',
      refusal: 'DELEGATION_REVOKED',
    },
  ]);
});

it('AW-11 child drops: the parent waits with the child’s fault shown and nothing re-delegates', async () => {
  const { parent, childId } = await delegated(w.s, w.helper);
  expect(await updateRaw(w.s, childId, 'expires_at = now()')).toBe('updated');
  expect(await resultsOf(w.s, parent)).toMatchObject([
    { childDelegationId: childId, state: 'dropped', outcome: null, fault: 'DELEGATION_EXPIRED' },
  ]);
  expect(await childRows(w.s, parent.id)).toHaveLength(1);
  // A child revoked on its own is dropped too, named as that.
  const second = await delegated(w.s, w.helper);
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await revokeDelegation(tx, second.childId);
  });
  expect(await resultsOf(w.s, second.parent)).toMatchObject([
    { state: 'dropped', fault: 'DELEGATION_REVOKED' },
  ]);
});

it('AW-11 partial handback names its refusal: none, or an unregistered code, is refused and nothing settles', async () => {
  const { parent, credential } = await delegated(w.s, w.helper);
  for (const handback of [
    { outcome: 'partial' },
    { outcome: 'partial', refusal: 'NOT_A_CODE' },
    { outcome: 'finished' },
  ]) {
    // oxlint-disable-next-line no-await-in-loop
    const refused = await handBack(w.s, w.helper, credential, handback as never);
    expect(refused.ok).toBe(false);
  }
  expect(await resultsOf(w.s, parent)).toMatchObject([{ state: 'working' }]);
});

it('AW-11 handback is the child’s own: the parent’s credential, another agent, or a second handback settle nothing', async () => {
  const { work, parent, credential } = await delegated(w.s, w.helper);
  const parentCredential = String(work.picked['credential']);
  // The parent's credential is no child's; the child's credential is bound to the helper.
  expect(
    codeOf(
      await w.s.db.app.withBusiness(
        w.s.business,
        async (tx) =>
          await handBackChild(
            tx,
            { agentActorId: w.s.agentActorId, credential: parentCredential },
            { outcome: 'completed' },
          ),
      ),
    ),
  ).toBe('DELEGATION_NOT_LIVE');
  expect(
    codeOf(
      await w.s.db.app.withBusiness(
        w.s.business,
        async (tx) =>
          await handBackChild(
            tx,
            { agentActorId: w.s.agentActorId, credential },
            { outcome: 'completed' },
          ),
      ),
    ),
  ).toBe('DELEGATION_NOT_LIVE');
  expect(await resultsOf(w.s, parent)).toMatchObject([{ state: 'working' }]);
  expect(codeOf(await handBack(w.s, w.helper, credential, { outcome: 'completed' }))).toBe('ok');
  expect(codeOf(await handBack(w.s, w.helper, credential, { outcome: 'completed' }))).toBe(
    'DELEGATION_NOT_LIVE',
  );
  const merged = (await eventsOn(w.s, work)).filter((event) => event.kind === 'child_handed_back');
  expect(merged).toHaveLength(1);
});

it('AW-11 two handbacks at once: one lands, the other waits on its locks and settles nothing', async () => {
  const { work, credential } = await delegated(w.s, w.helper);
  const first = racer(w.s);
  const [landed, gate] = [barrier(), barrier()];
  const landing = first.withBusiness(w.s.business, async (tx) => {
    const result = await handBackChild(
      tx,
      { agentActorId: w.helper.actorId, credential },
      { outcome: 'completed' },
    );
    landed.release();
    await gate.held;
    return result;
  });
  await landed.held;
  const second = handBack(w.s, w.helper, credential, {
    outcome: 'partial',
    refusal: 'BUDGET_UNAVAILABLE',
  });
  await awaitParked(w.s, 'records', 1);
  gate.release();
  expect(codeOf(await landing)).toBe('ok');
  await first.close();
  expect(codeOf(await second)).toBe('DELEGATION_NOT_LIVE');
  const merged = (await eventsOn(w.s, work)).filter((event) => event.kind === 'child_handed_back');
  expect(merged).toMatchObject([{ detail: { outcome: 'completed' } }]);
  // The parent's own lease is untouched by its helper's handback.
  const [lease] = await rows<{ state: string }>(
    w.s,
    `select state from public.leases where business_id = $1 and id = $2`,
    [w.s.business, work.picked['leaseId']],
  );
  expect(lease?.state).toBe('live');
});
