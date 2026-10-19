// SPDX-License-Identifier: AGPL-3.0-only
//
// Which refusal proves a carried task call unsent (#1703, #1623 R1). This
// side's own judgement, before the request is written to the M5 (the offer,
// the accept, the send fence), proves nothing left: the call is released and
// its run ends cancelled as custody not admitting it, the caller told the
// judgement's reason. The M5's word after it reported the write proves
// nothing: the same code from the M5 holds the call as liability unknown and
// the run ends on it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { liveWork, type Work } from '../runtime/schedules-harness.ts';
import { attemptOfLease, outcomesOfAttempt } from '../runs/run-outcomes-read.ts';
import { rowsOf, s, useBrokerWorld } from './broker-world.ts';
import { carriedCall, openCarriedTaskWorld, type CarriedTaskWorld } from './carried-task-world.ts';

const serverUrl = databaseUrlFromEnvironment();

useBrokerWorld('carrywrit');

const fresh = async (title: string): Promise<Work> =>
  await liveWork(s, `${title} ${randomUUID()}`, 2_000);

const stopOf = async (work: Work) => {
  const { attemptId } = await attemptOfLease(
    s.db.admin,
    s.business,
    String(work.picked['leaseId']),
  );
  return await outcomesOfAttempt(s.db.admin, s.business, attemptId);
};

describe.skipIf(serverUrl === undefined)('a carried task call refused after the write', () => {
  let world: CarriedTaskWorld;

  beforeAll(async () => {
    world = await openCarriedTaskWorld();
  }, 180_000);

  afterAll(async () => {
    await world?.close();
  });

  it('is held unknown when the M5 refuses with AUTHORITY_LOST once it reported the write', async () => {
    const work = await fresh('M5 refuses after the write');
    world.refusesAfterWrite = 'AUTHORITY_LOST';
    try {
      const answer = await carriedCall(world, work);
      const [row] = await rowsOf(answer.callId);
      expect(answer).toMatchObject({ ok: false });
      expect(row?.['state']).toBe('liability_unknown');
      expect(await stopOf(work)).toMatchObject([{ end_code: 'LIABILITY_UNKNOWN' }]);
    } finally {
      world.refusesAfterWrite = undefined;
    }
  }, 60_000);

  it('is released, cancelled as not admitted, when this side refuses the same code before the write', async () => {
    const work = await fresh('Carrier for another person');
    const { carrier } = world.broker;
    if (carrier === undefined) throw new Error('the world carries');
    const on = { ...world.broker, carrier: { ...carrier, people: [randomUUID()] } };
    const answer = await carriedCall(world, work, on);
    const [row] = await rowsOf(answer.callId);
    expect(answer).toMatchObject({ ok: false, code: 'CALL_RELEASED', reason: 'AUTHORITY_LOST' });
    expect(row?.['state']).toBe('released');
    expect(await stopOf(work)).toMatchObject([
      { outcome: 'cancelled', end_code: 'CUSTODY_NOT_ADMITTED' },
    ]);
  }, 60_000);
});
