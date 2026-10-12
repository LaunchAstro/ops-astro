// SPDX-License-Identifier: AGPL-3.0-only
//
// A CHECK constraint passes when it evaluates to NULL, so a guard that names
// a nullable column in a comparison lets a row through with that evidence
// missing. Each write below is the application role's, straight to the
// table: a keyed credential with no key id (0022), a dispatched step whose
// marker is NULL, which also skips the step's composite key to its marked
// attempt (0033), a marked attempt abandoned with no recorded abandonment
// (0037), and a top-up answer with no amount or currency (0088). Each is
// refused by the constraint that names that evidence.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { liveWork } from '../runtime/schedules-harness.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { people, stopped, usePeople } from './budget-answers-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('nullguard');
usePeople();

/** One statement as the application role in the world's business. */
const asApp = async (sql: string, params: readonly unknown[]): Promise<unknown> =>
  await s.db.app.withBusiness(s.business, async (tx) => await tx.query(sql, params));

/** A picked-up attempt, still unmarked, and its step. */
async function pickedUp(): Promise<{ readonly attemptId: string; readonly stepId: string }> {
  const work = await liveWork(s, `null guard ${randomUUID()}`, 2_000);
  const [row] = await s.db.admin.execute<{ readonly id: string; readonly step_id: string }>(
    `select id, step_id from public.attempts where lease_id = $1`,
    [work.picked['leaseId']],
  );
  if (row === undefined) throw new Error('no attempt for the lease');
  return { attemptId: row.id, stepId: row.step_id };
}

it('a keyed delegation credential with no key id is refused', async () => {
  const work = await liveWork(s, `null guard key ${randomUUID()}`, 2_000);
  const copy = asApp(
    `insert into public.delegations
     select * from jsonb_populate_record(null::public.delegations,
       (select to_jsonb(d) || jsonb_build_object(
                 'id', gen_random_uuid(), 'purpose', 'null_guard_copy',
                 'credential_hash', encode(sha256(gen_random_uuid()::text::bytea), 'hex'),
                 'credential_scheme', 'hmac-sha256-v1', 'credential_key_id', null)
          from public.delegations d where d.id = $1))`,
    [work.picked['delegationId']],
  );
  await expect(copy).rejects.toMatchObject({
    constraint_name: 'delegations_credential_key_matches_scheme',
  });
});

it('a step marked dispatched with a NULL marker is refused', async () => {
  const { attemptId, stepId } = await pickedUp();
  const write = asApp(
    `update public.planned_steps
        set dispatched_at = now(), dispatch_attempt_id = $2, dispatch_marked = null
      where id = $1`,
    [stepId, attemptId],
  );
  await expect(write).rejects.toMatchObject({ constraint_name: 'planned_steps_dispatch_named' });
});

it('a marked attempt abandoned with no recorded abandonment is refused', async () => {
  const { attemptId } = await pickedUp();
  const write = asApp(
    `update public.attempts set dispatch_marker = true, state = 'abandoned', outcome = null
      where id = $1`,
    [attemptId],
  );
  await expect(write).rejects.toMatchObject({
    constraint_name: 'attempts_marker_in_owning_state',
  });
});

it.each([
  ['no amount', null, 'AUD'],
  ['no currency', 500, null],
] as const)('a top-up answer with %s is refused', async (_label, amount, currency) => {
  const { runId, askId } = await stopped(`null guard top-up ${randomUUID()}`);
  const write = asApp(
    `insert into public.budget_answers
       (business_id, id, ask_id, run_id, kind, amount_minor, currency, first_person_id, hold_state)
     values ($1, $2, $3, $4, 'top_up', $5, $6, $7, 'held')`,
    [s.business, randomUUID(), askId, runId, amount, currency, people.approver.personId],
  );
  await expect(write).rejects.toMatchObject({ constraint_name: 'budget_answers_shape' });
});
