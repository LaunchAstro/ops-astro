// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-11: a child spends against its parent's envelope through the same path
// the parent does. It calls on the parent's lease, at the parent's fence,
// and the broker holds the call on the parent's reservation under the
// parent's locks, so one ceiling covers both and an exhausted envelope stops
// the child as it stops the parent. A child cannot widen by a new lease, and
// a parent that runs out ends the child's calls while its settled work stays.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { reserveModelCall } from '../../packages/core-custody/src/index.ts';
import { REPLAY_COMPOSE } from '../../packages/core-connectors/src/index.ts';
import { asAgent, codeOf, rows } from '../runtime/schedules-harness.ts';
import { updateRaw } from '../runtime/aw-11-child-world.ts';
import {
  callOn,
  callsOn,
  childCaller,
  childSpend,
  noDatabase,
  useSpendWorld,
  w,
} from './aw-11-spend-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useSpendWorld('aw11spend');

const agentOf = () => w.s.agent;

it("AW-11 child reserves against the parent's envelope", async () => {
  const x = await childSpend(w.s, w.helper, 2_000);
  expect(codeOf(await callOn(w.s, x.work, agentOf(), x.parentCredential))).toBe('applied');
  expect(codeOf(await callOn(w.s, x.work, w.helper.presented, x.childCredential))).toBe('applied');
  // Both calls on the parent's one reservation, settled at the replay's cost.
  const calls = await callsOn(w.s, x.work);
  expect(calls.map((call) => call.state)).toStrictEqual(['settled', 'settled']);
  const reservations = await rows<{ readonly n: string }>(
    w.s,
    `select count(distinct reservation_id)::text as n from public.model_calls where lease_id = $1`,
    [x.work.picked['leaseId']],
  );
  expect(reservations[0]?.n).toBe('1');
});

it('AW-11 envelope exhausted stops and asks', async () => {
  // 600: each call holds 500 and settles 100, so the third has no room.
  const x = await childSpend(w.s, w.helper, 600);
  expect(codeOf(await callOn(w.s, x.work, agentOf(), x.parentCredential))).toBe('applied');
  expect(codeOf(await callOn(w.s, x.work, w.helper.presented, x.childCredential))).toBe('applied');
  const stopped = await callOn(w.s, x.work, w.helper.presented, x.childCredential);
  expect(codeOf(stopped)).toBe('BUDGET_UNAVAILABLE');
  const calls = await callsOn(w.s, x.work);
  expect(calls.filter((call) => call.state === 'settled')).toHaveLength(2);
  expect(calls.some((call) => call.state === 'reserved' || call.state === 'dispatched')).toBe(
    false,
  );
});

it('AW-11 two child reservations at once cannot together pass the envelope', async () => {
  // 600 leaves room for one 500 hold, not two; both race on the parent's locks.
  const x = await childSpend(w.s, w.helper, 600);
  const [stepRow] = await rows<{ readonly step_id: string }>(
    w.s,
    `select step_id from public.attempts where business_id = $1 and lease_id = $2`,
    [w.s.business, x.work.picked['leaseId']],
  );
  const reserve = async () =>
    await w.s.db.app.withBusiness(
      w.s.business,
      async (tx) =>
        await reserveModelCall(
          tx,
          childCaller(w.helper, x.childId),
          {
            leaseId: String(x.work.picked['leaseId']),
            fence: Number(x.work.picked['fence']),
            stepId: String(stepRow?.step_id),
            operation: REPLAY_COMPOSE.key,
            fields: [{ name: 'tone', from: { recordId: x.work.taskId, key: 'title' } }],
          } as never,
          w.broker,
        ),
    );
  const results = await Promise.all([reserve(), reserve()]);
  expect(results.map((result) => (result.ok ? 'held' : result.code)).toSorted()).toStrictEqual([
    'BUDGET_UNAVAILABLE',
    'held',
  ]);
  expect((await callsOn(w.s, x.work)).filter((call) => call.state === 'reserved')).toHaveLength(1);
});

it('AW-11 no second delegation by a new lease', async () => {
  const x = await childSpend(w.s, w.helper, 2_000);
  const before = await rows<{ readonly n: string }>(
    w.s,
    `select count(*)::text as n from public.delegations where business_id = $1 and agent_actor_id = $2`,
    [w.s.business, w.helper.actorId],
  );
  const picked = await asAgent(
    { ...w.s, agent: w.helper.presented },
    {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId: x.work.decision['reservationId'],
      leaseSeconds: 600,
    },
    x.childCredential,
  );
  expect(codeOf(picked)).not.toBe('applied');
  const after = await rows<{ readonly n: string }>(
    w.s,
    `select count(*)::text as n from public.delegations where business_id = $1 and agent_actor_id = $2`,
    [w.s.business, w.helper.actorId],
  );
  expect(after[0]?.n).toBe(before[0]?.n);
  // The child still calls on the parent's lease; it has no lease of its own.
  expect(codeOf(await callOn(w.s, x.work, w.helper.presented, x.childCredential))).toBe('applied');
});

it('AW-11 parent expired keeps partial work', async () => {
  const x = await childSpend(w.s, w.helper, 2_000);
  expect(codeOf(await callOn(w.s, x.work, w.helper.presented, x.childCredential))).toBe('applied');
  const [parentRow] = await rows<{ readonly id: string }>(
    w.s,
    `select delegation_id as id from public.leases where business_id = $1 and id = $2`,
    [w.s.business, x.work.picked['leaseId']],
  );
  expect(await updateRaw(w.s, String(parentRow?.id), 'expires_at = now()')).toBe('updated');
  expect(codeOf(await callOn(w.s, x.work, w.helper.presented, x.childCredential))).toBe(
    'DELEGATION_EXPIRED',
  );
  // The settled call stays on the ledger; nothing new was held.
  expect((await callsOn(w.s, x.work)).map((call) => call.state)).toStrictEqual(['settled']);
});
