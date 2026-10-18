// SPDX-License-Identifier: AGPL-3.0-only
//
// #1904 P12 (design v3, "P12 protocol"): the start and custody's admission
// each bind the definition part again, under their own locks. Each case runs
// beside a disposable control, a second run built the same way and paused at
// the same seam. Immediately before the deletion, an unlocked read on the
// owner connection shows every earlier guard still passes on the case run;
// then the owner connection deletes the case run's ledger row, which no
// application role can do, and both are let go.
//
// 1. Start: both reserve a [definition, task] turn, committed, and wait
//    before the start opens its transaction. The case call is released with
//    `PROVENANCE_UNBOUND` in its `model.call_released` event and nothing
//    reaches the provider; the control starts and settles.
// 2. Admission: both on an owner-own, business-internal task on a
//    subscription route, the sends custody admits, dispatched and waiting
//    before `taskAdmission`'s judge. The case is not admitted
//    (`CUSTODY_NOT_ADMITTED`), with nothing sent; the control is admitted.

import { describe, expect, it } from 'vitest';
import { sendReservedCall } from '../../packages/core-custody/src/index.ts';
import { taskAdmission } from '../../packages/core-custody/src/broker-admission.ts';
import { serverUrl } from '../acceptance/world.ts';
import { auditFromHere, s, world } from './run-stop-door-world.ts';
import {
  deleteTheLedgerRow,
  rebindBroker,
  reservedTurn,
  standingOf,
  type Reserved,
} from './definition-rebind.ts';
import { useDefinitionWorld } from './definition-world.ts';
import { replied } from './turn-world.ts';

const send = async (at: Reserved, broker: ReturnType<typeof rebindBroker>) =>
  await sendReservedCall(s.db.app, s.business, at.caller, at.request, at.reserved, broker);

const callState = async (at: Reserved): Promise<string | undefined> =>
  (
    await s.db.admin.execute<{ state: string }>(
      'select state from public.model_calls where business_id = $1 and id = $2',
      [s.business, at.reserved.callId],
    )
  )[0]?.state;

const admit = async (at: Reserved) =>
  await taskAdmission(s.db.app, s.business, at.request, at.reserved)();

async function atTheStart(): Promise<void> {
  const broker = rebindBroker('api_key');
  const testCase = await reservedTurn('definition rebind at start, case', broker, null);
  const control = await reservedTurn('definition rebind at start, control', broker, null);
  expect(await standingOf(testCase)).toEqual({
    leaseLive: true,
    fence: String(testCase.request.fence),
    delegationLive: true,
    call: 'reserved',
    client: null,
    calls: 1,
  });
  await deleteTheLedgerRow(testCase);
  const audit = await auditFromHere();
  const seen = world.provider.seen.length;
  // Mutation: the start skips definition parts -> the case is sent and settles, red.
  const refused = await send(testCase, broker);
  expect(refused).toMatchObject({ ok: false, code: 'PROVENANCE_UNBOUND' });
  expect(await callState(testCase)).toBe('released');
  expect(world.provider.seen.length, 'nothing reached the provider').toBe(seen);
  expect((await audit()).filter((event) => event.command === 'model.call_released')).toMatchObject([
    { refusal_code: 'PROVENANCE_UNBOUND' },
  ]);
  world.provider.script([replied('Done.')]);
  expect(await send(control, broker), 'the control starts and settles').toMatchObject({
    ok: true,
  });
  expect(await callState(control)).toBe('settled');
}

async function atAdmission(): Promise<void> {
  const broker = rebindBroker('subscription');
  const owner = s.decider.personId;
  const testCase = await reservedTurn('definition rebind at admission, case', broker, owner);
  const control = await reservedTurn('definition rebind at admission, control', broker, owner);
  // Dispatched, as the start leaves them, and waiting before custody's admit seam.
  await Promise.all(
    [testCase, control].map(
      async (at) =>
        await s.db.admin.execute(
          `update public.model_calls set state = 'dispatched', started_at = clock_timestamp()
            where business_id = $1 and id = $2`,
          [s.business, at.reserved.callId],
        ),
    ),
  );
  expect(await standingOf(testCase)).toMatchObject({
    leaseLive: true,
    delegationLive: true,
    call: 'dispatched',
    client: null,
  });
  await deleteTheLedgerRow(testCase);
  const seen = world.provider.seen.length;
  // Mutation: admission skips definition parts -> the case is admitted, red.
  expect(await admit(testCase), 'CUSTODY_NOT_ADMITTED').toBeUndefined();
  const admitted = await admit(control);
  expect(admitted, 'the control is admitted').toBeDefined();
  expect(await admitted?.go()).toBe(true);
  expect(world.provider.seen.length, 'nothing sent for the case').toBe(seen);
}

describe.skipIf(serverUrl === undefined)('a definition at the start and at admission', () => {
  useDefinitionWorld('defrebind');

  it(
    '1: the start binds it again: the case is released PROVENANCE_UNBOUND, the control settles',
    atTheStart,
    90_000,
  );
  it('2: admission binds it again: the case is not admitted, the control is', atAdmission, 90_000);
});
