// SPDX-License-Identifier: AGPL-3.0-only
//
// `AW-08 approval gate` (standing gate 5): nothing leaves before the launch
// decision on its exact version. The plan accept lets the agent work and
// releases no effect; the launch of a reviewed output does. At dispatch the
// facts are rechecked under the locks, and each moved one answers with its own
// code and marks nothing: a reset approval `DECISION_STALE`, a superseded
// version `PROPOSAL_SUPERSEDED`, a rejected lineage `LINEAGE_TERMINAL`, a
// revoked delegation `AUTHORITY_LOST` (asked of the runtime itself: the agent's
// command entry refuses a dead delegation before it reaches dispatch).
//
// The launch is the accept of a handed-back successor, marked a reviewed output
// by AW-08 (a)'s handback (0213); the plan accept's work is `LAUNCH_NOT_DECIDED`.

import { expect, it as vitestIt } from 'vitest';
import { noDatabase, useAw04World, w } from './aw-04-world.ts';
import { dispatch } from '../../packages/core-runtime/src/dispatch.ts';
import { codeOf, rows } from './schedules-harness.ts';
import { TASK_COLLECTION } from './fixture.ts';
import { dispatchAs, leased, marked } from './aw-08-gate-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useAw04World('aw08gate');

it('AW-08 approval gate: the plan accept releases no effect; its work is refused LAUNCH_NOT_DECIDED at dispatch and nothing is marked', async () => {
  const plan = await leased(w.alpha, 'plan');
  const early = await dispatchAs(w.alpha, plan);
  expect(codeOf(early), 'the plan accept alone released the effect').toBe('LAUNCH_NOT_DECIDED');
  expect(await marked(w.alpha, plan.taskId)).toBe(0);
  // Control: the launch of a reviewed output dispatches, once.
  const launched = await leased(w.alpha, 'launch');
  expect(codeOf(await dispatchAs(w.alpha, launched))).toBe('applied');
  expect(await marked(w.alpha, launched.taskId)).toBe(1);
});

it.each([
  [
    'a reset approval',
    'DECISION_STALE',
    // What a later version does to the approval (`proposal-writer.ts`), version left current.
    `update public.gates set state = 'superseded', decided_at = now()
      where business_id = $1 and version_id = $2`,
  ],
  [
    'a superseded version',
    'PROPOSAL_SUPERSEDED',
    'update public.proposal_versions set superseded_at = now() where business_id = $1 and id = $2',
  ],
  [
    'a rejected lineage',
    'LINEAGE_TERMINAL',
    `update public.proposal_lineages
        set state = 'rejected', terminal_reason = 'removed', terminal_at = now()
      where business_id = $1
        and id = (select lineage_id from public.proposal_versions where business_id = $1 and id = $2)`,
  ],
] as const)(
  'AW-08 approval gate: %s after the launch is refused %s at dispatch, and nothing is marked',
  async (_move, code, move) => {
    const work = await leased(w.alpha, 'launch');
    await w.alpha.db.admin.execute(move, [w.alpha.business, work.proposal['versionId']]);
    expect(codeOf(await dispatchAs(w.alpha, work))).toBe(code);
    expect(await marked(w.alpha, work.taskId)).toBe(0);
  },
);

it('AW-08 approval gate: a delegation revoked after the launch is refused AUTHORITY_LOST inside dispatch, and nothing is marked', async () => {
  const work = await leased(w.alpha, 'launch');
  const [lease] = await rows<{ delegation_id: string }>(
    w.alpha,
    'select delegation_id from public.leases where business_id = $1 and id = $2',
    [w.alpha.business, work.picked['leaseId']],
  );
  const delegationId = String(lease?.delegation_id);
  await w.alpha.db.admin.execute(
    `update public.delegations set revoked_at = now(), revocation_cause = 'delegation_revoked'
      where business_id = $1 and id = $2`,
    [w.alpha.business, delegationId],
  );
  const answer = await w.alpha.db.app.withBusiness(
    w.alpha.business,
    async (tx) =>
      await dispatch(tx, {
        claimant: 'agent',
        leaseId: String(work.picked['leaseId']),
        fence: Number(work.picked['fence']),
        holderActorId: w.alpha.agentActorId,
        delegationId,
        collection: TASK_COLLECTION,
      }),
  );
  expect(answer.ok ? 'applied' : answer.refusal.code).toBe('AUTHORITY_LOST');
  expect(await marked(w.alpha, work.taskId)).toBe(0);
});
