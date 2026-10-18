// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R1, a named start refusal: a reserved call whose prompt copy was never
// registered is refused `COPY_NOT_REGISTERED` at its start and sends nothing.
// Like every other recorded refusal it ends the attempt, `cancelled /
// COPY_NOT_REGISTERED`, and releases the lease. Proof by Sol (GPT-6.1-Sol),
// review of #1896 at 059b30dcd9, finding S1896-1; assertions unchanged.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { REPLAY_COMPOSE } from '../../packages/core-connectors/src/index.ts';
import { sendReservedCall } from '../../packages/core-custody/src/index.ts';
import { liveWork } from '../runtime/schedules-harness.ts';
import {
  broker,
  caller,
  requestFor,
  s,
  stepOf,
  useBrokerWorld,
  world,
} from '../broker/broker-world.ts';
import { attemptOfLease, outcomesOfAttempt } from './run-outcomes-read.ts';
import { serverUrl } from '../acceptance/world.ts';

useBrokerWorld('r1copystop');

describe.skipIf(serverUrl === undefined)('a start refused for an unregistered prompt copy', () => {
  it('COPY_NOT_REGISTERED records its cancelled outcome and retires the attempt', async () => {
    const work = await liveWork(s, 'an unsent hold without a registered prompt', 2_000);
    await stepOf(work);
    const request = requestFor(work);
    const callId = randomUUID();
    // A real reserved call whose required prompt registration is absent: the exact
    // fail-closed state COPY_NOT_REGISTERED exists to refuse, with no query mocks.
    await s.db.app.withBusiness(s.business, async (tx) => {
      await tx.query(
        `insert into public.model_calls
      (business_id, id, run_id, step_id, lease_id, version_id, reservation_id,
       delegation_id, caller_delegation_id, operation_key, state, reserved_minor,
       route_key, route_reach, credential_kind)
      select l.business_id, $2, l.run_id, $3, l.id, r.version_id, r.id,
             l.delegation_id, l.delegation_id, $4, 'reserved', 500, 'replay', 'cloud', 'api_key'
        from public.leases l join public.reservations r on r.business_id = l.business_id
         and r.id = l.reservation_id where l.business_id = $1 and l.id = $5`,
        [s.business, callId, request.stepId, REPLAY_COMPOSE.key, request.leaseId],
      );
    });
    const operation = broker.operations.get(REPLAY_COMPOSE.key)!;
    const seen = world.provider.seen.length;
    const result = await sendReservedCall(
      s.db.app,
      s.business,
      caller(work),
      request,
      { callId, operation, route: broker.routes[0]!, reservedMinor: 500 },
      broker,
    );
    expect(result).toMatchObject({ ok: false, code: 'COPY_NOT_REGISTERED' });
    expect(world.provider.seen.length).toBe(seen);
    const { attemptId } = await attemptOfLease(s.db.admin, s.business, request.leaseId);
    expect(
      await outcomesOfAttempt(s.db.admin, s.business, attemptId),
      'the named pre-send refusal must record its outcome',
    ).toMatchObject([{ outcome: 'cancelled', end_code: 'COPY_NOT_REGISTERED' }]);
    expect(
      await s.db.admin.execute('select state from public.leases where id = $1', [request.leaseId]),
    ).toMatchObject([{ state: 'released' }]);
  });
});
