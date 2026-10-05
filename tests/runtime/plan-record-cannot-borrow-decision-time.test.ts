// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #436 (Sol OW-050 criterion 7): a plan record is bound only when it
// is written in its decision's transaction. A record the product's role
// inserts later, with genuine digests and the decision's timestamp copied
// into `bound_at`, must never become the task's plan.
import { expect, it as vitestIt } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { payloadDigest } from '../../packages/core-digest/src/index.ts';
import { appliedDetail, approveBody, asPerson, createTask, rows } from './schedules-harness.ts';
import { acceptPlanOn, graphAs, noDatabase, proposeStep, useAw06World, w } from './aw-06-world.ts';

/** The case needs the database; without one the file is skipped, as aw-06-planned-layer is. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useAw06World('planborrow');

it('a correctly hashed record inserted after approval cannot borrow the decision timestamp', async () => {
  const taskId = await createTask(w.s, 'Sol OW-050 unapproved plan');
  const accepted = await acceptPlanOn(taskId);
  const proposal = appliedDetail(
    await proposeStep(taskId, {
      kind: 'synthetic_comment',
      payload: {},
    }),
    'propose without a plan record',
  );
  appliedDetail(await asPerson(w.s, approveBody(proposal)), 'approve without a plan record');
  const [decision] = await rows<{ id: string }>(
    w.s,
    'select id from public.gate_decisions where gate_id = $1',
    [proposal['gateId']],
  );
  const text = 'These words and this structured plan were never approved.';
  const record = { steps: [{ key: 'forged', title: 'An unapproved step', after: [] }] };
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await tx.query(
      `insert into public.plan_records
      (business_id, id, gate_id, decision_id, run_id, plan_text, text_digest,
       record, record_digest, bound_by_actor_id, bound_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        (select decided_at from public.gate_decisions where business_id = $1 and id = $4))`,
      [
        tx.businessId,
        randomUUID(),
        proposal['gateId'],
        decision?.id,
        proposal['runId'],
        text,
        createHash('sha256').update(text).digest('hex'),
        record,
        payloadDigest(record),
        w.s.decider.actorId,
      ],
    );
  });
  expect((await graphAs(w.s.decider, taskId)).planRecordId).toBe(accepted.planRecordId);
});
