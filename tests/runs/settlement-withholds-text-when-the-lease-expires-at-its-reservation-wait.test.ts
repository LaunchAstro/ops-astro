// SPDX-License-Identifier: AGPL-3.0-only
//
// Proof by Sol (GPT-6.1-Sol), review of #1940 at f00e5a4d71, finding S1940-2;
// assertions unchanged.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { settle } from '../../packages/core-custody/src/broker-settle.ts';
import { reserveModelCall, type Broker } from '../../packages/core-custody/src/index.ts';
import {
  catalogue,
  REPLAY_COMPOSE,
  replayAdapter,
  replayCostMinor,
} from '../../packages/core-connectors/src/index.ts';
import { openCustodyWorld, type CustodyWorld } from '../custody/custody-world.ts';
import {
  awaitParked,
  holdRows,
  liveWork,
  openSchedules,
  startedBefore,
  waitPast,
  type Schedules,
} from '../runtime/schedules-harness.ts';

describe.skipIf(serverUrl === undefined)('a settlement past its lease', () => {
  let s: Schedules;
  let world: CustodyWorld;
  beforeAll(async () => {
    s = await openSchedules('solexpiry1940', 1_000_000);
    world = await openCustodyWorld();
  });
  afterAll(async () => {
    await world?.close();
    await s?.db.drop();
  });

  it('settlement withholds text when the lease expires at its reservation wait', async () => {
    const work = await liveWork(s, 'Sol expired settlement', 2_000);
    const leaseId = String(work.picked['leaseId']);
    const [step] = await s.db.admin.execute<{ step_id: string }>(
      'select step_id from public.attempts where business_id = $1 and lease_id = $2',
      [s.business, leaseId],
    );
    const broker: Broker = {
      custody: world.custody,
      operations: catalogue([REPLAY_COMPOSE]),
      providers: new Map([['replay', { build: replayAdapter, price: replayCostMinor }]]),
      routes: [
        {
          key: 'replay',
          reach: 'cloud',
          provider: 'replay',
          credentialRef: 'replay_key',
          credentialKind: 'api_key',
          installation: 'here',
          ceiling: 1_000,
        },
      ],
      installation: 'here',
      audit: async () => {},
    };
    const caller = {
      actorId: s.agentActorId,
      delegationId: String(work.picked['delegationId']),
      attendedByPersonId: null,
    };
    const request = {
      leaseId,
      fence: Number(work.picked['fence']),
      stepId: String(step?.step_id),
      operation: REPLAY_COMPOSE.key,
      fields: [{ name: 'tone', from: { recordId: work.taskId, key: 'title' } }],
    };
    const held = await s.db.app.withBusiness(
      s.business,
      async (tx) => await reserveModelCall(tx, caller, request, broker),
    );
    if (!held.ok) throw new Error(`setup: reserve refused ${held.code}`);
    await s.db.admin.execute(
      `update public.model_calls set state = 'dispatched', started_at = clock_timestamp() where business_id = $1 and id = $2`,
      [s.business, held.reserved.callId],
    );
    const answer = REPLAY_COMPOSE.answer({
      text: 'Sol private answer',
      model: 'replay-1',
      usage: { input: 40, output: 30 },
    });
    if (answer === undefined) throw new Error('setup: invalid replay answer');
    await s.db.admin.execute(
      `update public.leases set expires_at = clock_timestamp() + interval '3 seconds' where business_id = $1 and id = $2`,
      [s.business, leaseId],
    );
    const holder = await holdRows(s, 'reservations', [String(work.decision['reservationId'])]);
    let pending: ReturnType<typeof settle> | undefined;
    try {
      pending = settle(
        s.db.app,
        s.business,
        caller,
        request,
        held.reserved,
        {
          kind: 'priced',
          answer,
          costMinor: 1,
          account: null,
          credentialKind: 'replay',
        },
        broker,
      );
      await awaitParked(s, 'reservations', 1);
      const expiry = 'select expires_at from public.leases where id = $1';
      expect(await startedBefore(s, expiry, leaseId)).toBe(true);
      await waitPast(s, expiry, leaseId);
    } finally {
      await holder.release();
    }
    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: 'LEASE_EXPIRED' });
    expect(result).not.toHaveProperty('text');
  }, 60_000);
});
