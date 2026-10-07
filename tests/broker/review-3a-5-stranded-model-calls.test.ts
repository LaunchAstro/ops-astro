// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-BATCH-2 batch 3a, defect 5: stranded model calls are never swept.
// core-custody's sweepModelCalls (broker.ts) has no product caller: the API's
// interval sweep, sweepDeployment in apps/api/recovery-entry.ts, runs only
// sweepLostWorkers. A call reserved or sent on a lease that then expires stays
// 'reserved' or 'dispatched' for ever, counting as in flight and holding its
// maximum against the reservation with no person told.
//
// Red on 8cbd0e422 (batch 3a before its fix squash). Green once the deployment sweep also runs the model-call
// half (sweepModelCalls, or the same rule) in each business's transaction.
//
// Label (ORCH62, first detector wins): a sent call whose worker was lost is
// held by AW-10's runtime half first, as `dropped_worker_lost`; a sent call
// with no worker to lose that gets no answer is `dropped_no_answer`.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { sweepDeployment } from '../../apps/api/recovery-entry.ts';
import { liveWork } from '../runtime/schedules-harness.ts';
import { seedConversation } from './conversation-fixture.ts';
import { noDatabase, rowsOf, s, stepOf, useBrokerWorld } from './broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('rv3a5');

/** The deployment's one configured business key. */
const resolve = async (key: string): Promise<string | undefined> =>
  await Promise.resolve(key === 'home' ? s.business : undefined);

it('REVIEW-3A-5: the deployment sweep releases a reserved call and holds a dispatched call on an expired lease', async () => {
  const work = await liveWork(s, 'rv3a5 stranded calls', 2_000);
  const step = await stepOf(work);
  const [started, unsent] = [randomUUID(), randomUUID()];
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (const [id, state] of [
      [started, 'dispatched'],
      [unsent, 'reserved'],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      await tx.query(
        `insert into public.model_calls
           (business_id, id, run_id, step_id, lease_id, version_id, reservation_id, operation_key,
            state, reserved_minor, route_key, route_reach, credential_kind, started_at)
         select l.business_id, $2, l.run_id, $3, l.id, r.version_id, r.id, 'model.replay_compose',
                $4, 500, 'replay', 'cloud', 'api_key', case when $4 = 'dispatched' then clock_timestamp() end
           from public.leases l join public.reservations r on r.id = l.reservation_id
          where l.business_id = $1 and l.id = $5`,
        [tx.businessId, id, step, state, work.picked['leaseId']],
      );
    }
  });
  // Setup: both rows exist in the states the sweep must move.
  expect(await rowsOf(started)).toMatchObject([{ state: 'dispatched' }]);
  expect(await rowsOf(unsent)).toMatchObject([{ state: 'reserved' }]);
  await s.db.admin.execute(
    `update public.leases set expires_at = clock_timestamp() where id = $1`,
    [work.picked['leaseId']],
  );

  // The pass the API runs on its interval, over the configured business key.
  const outcome = await sweepDeployment(s.db.app, resolve, ['home']);
  expect(outcome).toMatchObject({ ok: true, businesses: [{ key: 'home' }] });

  // The defect: neither row moves, because the deployment sweep never calls
  // the model-call half.
  expect(await rowsOf(unsent), 'the never-sent call must be released').toMatchObject([
    { state: 'released' },
  ]);
  expect(await rowsOf(started), 'the sent call must be held as an unknown liability').toMatchObject(
    [{ state: 'liability_unknown', fault: 'ours', drop_state: 'dropped_worker_lost' }],
  );
});

it('REVIEW-3A-5: the deployment sweep holds a sent call that got no answer as dropped_no_answer', async () => {
  // A conversation call has no lease and no worker to lose: past ten minutes
  // started with no answer, the model-call half holds it.
  const unanswered = randomUUID();
  const conversation = await seedConversation(s);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await tx.query(
      `insert into public.model_calls
         (business_id, id, conversation_id, operation_key, state, reserved_minor,
          route_key, route_reach, credential_kind, accepted_at, started_at)
       values ($1, $2, $3, 'model.replay_compose', 'dispatched', 0,
               'on_premises', 'local', 'api_key',
               clock_timestamp() - interval '11 minutes',
               clock_timestamp() - interval '11 minutes')`,
      [tx.businessId, unanswered, conversation.id],
    );
  });

  const outcome = await sweepDeployment(s.db.app, resolve, ['home']);

  expect(outcome).toMatchObject({ ok: true, businesses: [{ key: 'home' }] });
  expect(await rowsOf(unanswered)).toMatchObject([
    { state: 'liability_unknown', fault: 'ours', drop_state: 'dropped_no_answer' },
  ]);
});
