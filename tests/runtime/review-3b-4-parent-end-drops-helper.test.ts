// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-BATCH-2 #313, batch 3b, defect 4: ending the parent never ends its
// helpers in the merged result. `childResults` and `childStateOf`/`faultOf`
// (core-runtime child-handback.ts) read only the child delegation's own row,
// and nothing cascades from `revokeDelegation`, `settleDelegation` or the
// authority-loss pass to the parent's children. So a parent revoked, or a
// parent that hands its work back, still shows its helper as `working` with
// no fault, although the helper can do nothing more on that work.
//
// The cases: a helper is handed part of the work and never hands back; then
// the parent is revoked (and, separately, the parent hands its work back
// through task.handback). The parent's merged result must show the helper
// dropped with a fault: DELEGATION_REVOKED for the revocation. On 51c13c7cb it
// reads `working` with fault null.

import { expect, it as vitestIt } from 'vitest';
import { revokeDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { appliedDetail, asAgent, handbackBody } from './schedules-harness.ts';
import { noDatabase, useChildWorld, w } from './aw-11-child-world.ts';
import { delegated, resultsOf } from './aw-11-child-work-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useChildWorld('rv3b4');

it('REVIEW-3B-4: the parent revoked with no handback from its helper: the merged result shows the helper dropped, DELEGATION_REVOKED, not working', async () => {
  const { parent, childId } = await delegated(w.s, w.helper);
  expect(await resultsOf(w.s, parent)).toMatchObject([
    { childDelegationId: childId, state: 'working' },
  ]);
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await revokeDelegation(tx, parent.id);
  });
  expect(
    await resultsOf(w.s, parent),
    "the revoked parent's helper still reads as working: childStateOf reads only the child's own row",
  ).toMatchObject([
    { childDelegationId: childId, state: 'dropped', outcome: null, fault: 'DELEGATION_REVOKED' },
  ]);
});

it('REVIEW-3B-4: the parent hands its work back while its helper never did: the merged result shows the helper dropped with a fault, not working', async () => {
  const { work, parent, childId } = await delegated(w.s, w.helper);
  appliedDetail(
    await asAgent(w.s, handbackBody(work.picked), String(work.picked['credential'])),
    'task.handback',
  );
  const [result, ...more] = await resultsOf(w.s, parent);
  expect(more).toStrictEqual([]);
  expect(
    result,
    "the handed-back parent's helper still reads as working: nothing cascades from settleDelegation",
  ).toMatchObject({ childDelegationId: childId, state: 'dropped', outcome: null });
  expect(result?.fault, 'a dropped helper names its fault').toEqual(expect.any(String));
});
