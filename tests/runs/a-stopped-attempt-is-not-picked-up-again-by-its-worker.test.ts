// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R1 (B2): a stop ends the attempt, with no retry, and only a person's
// `task.restart` starts the next one. The worker a stop retired cannot take
// its old reservation back through `task.pickup`: after its own `run.end`,
// and after a recorded `RATE_LIMITED` reserve refusal, the pickup is refused
// RESERVATION_NOT_CLAIMABLE and writes nothing. A lease that only expired,
// with no stop recorded on it, is still replaced (R5).

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { reserveModelCall } from '../../packages/core-custody/src/index.ts';
import { asAgent, codeOf, liveWork, rows, type Work } from '../runtime/schedules-harness.ts';
import {
  auditAs,
  broker,
  CLOUD,
  noDatabase,
  requestFor,
  s,
  stepOf,
  useBrokerWorld,
} from '../broker/broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('r1repick');

const pickupAgain = async (work: Work) =>
  await asAgent(s, {
    command: 'task.pickup',
    operationId: randomUUID(),
    reservationId: work.decision['reservationId'],
    leaseSeconds: 600,
  });

/** Every row the pickup could write for this task's runs. */
const written = async (work: Work) => ({
  reservations: await rows(
    s,
    `select r.id, r.state from public.reservations r
       join public.planned_runs p on p.business_id = r.business_id and p.id = r.run_id
      where r.business_id = $1 and p.task_id = $2 order by r.id`,
    [s.business, work.taskId],
  ),
  attempts: await rows(
    s,
    `select a.id, a.state from public.attempts a
       join public.reservations r on r.business_id = a.business_id and r.id = a.reservation_id
       join public.planned_runs p on p.business_id = r.business_id and p.id = r.run_id
      where a.business_id = $1 and p.task_id = $2 order by a.id`,
    [s.business, work.taskId],
  ),
  leases: await rows(
    s,
    `select id, state from public.leases where business_id = $1 and task_id = $2 order by id`,
    [s.business, work.taskId],
  ),
  delegations: await rows(
    s,
    `select d.id, d.revoked_at is null as live from public.delegations d
       join public.leases l on l.business_id = d.business_id and l.delegation_id = d.id
      where d.business_id = $1 and l.task_id = $2 order by d.id`,
    [s.business, work.taskId],
  ),
});

async function refusedAndNothingWritten(work: Work): Promise<void> {
  const before = await written(work);
  expect(codeOf(await pickupAgain(work))).toBe('RESERVATION_NOT_CLAIMABLE');
  expect(await written(work)).toStrictEqual(before);
}

it("after its own run.end, the worker's pickup of the same reservation is refused and writes nothing", async () => {
  const work = await liveWork(s, `ended then picked again ${randomUUID()}`, 2_000);
  const ended = await asAgent(
    s,
    {
      command: 'run.end',
      operationId: randomUUID(),
      leaseId: work.picked['leaseId'],
      fence: work.picked['fence'],
      endCode: 'TOOL_REFUSED',
    },
    String(work.picked['credential']),
  );
  expect(codeOf(ended)).toBe('RUN_ENDED');
  await refusedAndNothingWritten(work);
});

it('after a recorded RATE_LIMITED reserve refusal, the pickup of the same reservation is refused and writes nothing', async () => {
  const full = { ...broker, routes: [{ ...CLOUD, key: 'r1-repick', ceiling: 1 }] };
  const reserve = async (work: Work) => {
    await stepOf(work);
    return await s.db.app.withBusiness(
      s.business,
      async (tx) =>
        await reserveModelCall(
          tx,
          {
            actorId: s.agentActorId,
            delegationId: String(work.picked['delegationId']),
            attendedByPersonId: null,
          },
          requestFor(work),
          { ...full, audit: auditAs(s.agentActorId) },
        ),
    );
  };
  const holder = await liveWork(s, `holds the route ${randomUUID()}`, 2_000);
  expect(await reserve(holder)).toMatchObject({ ok: true });
  const work = await liveWork(s, `refused then picked again ${randomUUID()}`, 2_000);
  expect(await reserve(work)).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
  await refusedAndNothingWritten(work);
});

it('control (R5): a lease and delegation that only expired, with no stop recorded, are replaced by the pickup', async () => {
  const work = await liveWork(s, `expired then replaced ${randomUUID()}`, 2_000);
  await s.db.admin.execute(
    `update public.leases set expires_at = clock_timestamp() - interval '1 second'
      where business_id = $1 and id = $2`,
    [s.business, work.picked['leaseId']],
  );
  await s.db.admin.execute(
    `update public.delegations
        set granted_at = least(granted_at, clock_timestamp() - interval '2 seconds'),
            expires_at = clock_timestamp() - interval '1 second'
      where business_id = $1 and id = $2`,
    [s.business, work.picked['delegationId']],
  );
  expect(codeOf(await pickupAgain(work))).toBe('applied');
});
