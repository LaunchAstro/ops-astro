// SPDX-License-Identifier: AGPL-3.0-only
//
// #1886 beside design F1. The final standing check asks a write's grants again
// after its last wait, but a retained stop is judged on its delegation alone:
// it retires its own work, and refusing it would leave that work running.
//
// Through the real HTTP agent door: the run is held, `run.end` parks on it,
// and every grant the delegating person holds is revoked on a second
// connection and commits before the run is let go. The stop still answers
// `RUN_ENDED` and commits its outcome and retirement.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import type { Answer } from '../api/fixture.ts';
import { holdRows, liveWork, rows, type Work } from '../runtime/schedules-harness.ts';
import {
  asAgent,
  callBody,
  durable,
  independently,
  leaseOf,
  noDatabase,
  parkedUnlessAnswered,
  s,
  signedIn,
  useDoorWorld,
  world,
  type SignedIn,
} from './run-stop-door-world.ts';
import { attemptOfLease } from './run-outcomes-read.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useDoorWorld('runendgrants');

/** Live work with one replay call already settled on it, as the worker would have it. */
async function settledOnce(as: SignedIn): Promise<Work> {
  const work = await liveWork(s, 'ends, grants revoked', 2_000);
  world.provider.mode('answer');
  const answered = await asAgent('/model/call', work, callBody(work), as);
  expect(answered.body['detail'], JSON.stringify(answered.body)).toMatchObject({
    state: 'settled',
  });
  return work;
}

/** Revoke every grant in the business on a second connection, and commit. */
async function revokeEveryGrant(): Promise<void> {
  const revoked = await independently(
    async (tx) =>
      await tx.query(
        `update public.grants set revoked_at = greatest(now(), granted_at)
          where business_id = $1 and revoked_at is null`,
        [tx.businessId],
      ),
  );
  await revoked.release();
}

/** `run.end` parked on its held run while every grant is revoked, then let go. */
async function endedWhileRevoked(work: Work, as: SignedIn) {
  const { runId } = await attemptOfLease(s.db.admin, s.business, leaseOf(work));
  const body = {
    operationId: randomUUID(),
    leaseId: work.picked['leaseId'],
    fence: work.picked['fence'],
    endCode: 'TOOL_REFUSED',
  };
  const run = await holdRows(s, 'planned_runs', [runId]);
  let ending: Promise<Answer> | undefined;
  let waited = false;
  try {
    ending = asAgent('/run/end', work, body, as);
    waited = await parkedUnlessAnswered(ending, 'planned_runs', 1);
    if (waited) await revokeEveryGrant();
  } finally {
    await run.release();
  }
  return { reply: await ending, waited };
}

it('run.end whose delegating grants were revoked while it waited on the run commits its stop', async () => {
  const as = await signedIn();
  const work = await settledOnce(as);
  const { reply, waited } = await endedWhileRevoked(work, as);
  expect(waited, 'run.end waited on the run').toBe(true);
  const live = await rows<{ n: number }>(
    s,
    'select count(*)::int as n from public.grants where business_id = $1 and revoked_at is null',
    [s.business],
  );
  expect(live, 'no grant was left to the delegating person').toEqual([{ n: 0 }]);
  expect(reply.body['code'], `${String(reply.status)} ${JSON.stringify(reply.body)}`).toBe(
    'RUN_ENDED',
  );
  expect(await durable(work)).toMatchObject({
    outcomes: [{ outcome: 'cancelled', end_code: 'TOOL_REFUSED' }],
    lease: 'released',
    delegationRevoked: true,
    revocationCause: 'work_retired',
  });
});
