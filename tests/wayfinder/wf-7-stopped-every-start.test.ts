// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7 (#640) "Twice failed, it stops": the stop holds whichever way the next
// run would begin. A run proposed before the second failure, and approved
// after it, is not picked up while the map's owner is asked; nor is a restart
// of a failed lineage by another person holding decide on the ticket. The
// shared cases are in wf-7-failures.ts. On the real commands against Postgres.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  approveBody,
  asAgent,
  codeOf,
  openSchedules,
  pickup,
  type Detail,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import {
  approve,
  approverOf,
  asksOn,
  charter,
  fail,
  failedRun,
  researchOnMap,
  runOn,
  start,
} from './wf-7-failures.ts';

/** Every case needs the database; without one the file is skipped. */
const noDatabase = databaseUrlFromEnvironment() === undefined;
const it = noDatabase ? vitestIt.skip : vitestIt;

let s: Schedules;
let owner: Member;

beforeAll(async () => {
  if (noDatabase) return;
  s = await openSchedules('wf7everystart', 1_000_000);
  owner = await charter(s, 'map-owner');
}, 180_000);
afterAll(async () => await s?.db.drop());

const as = async (who: Member, body: Readonly<Record<string, unknown>>): Promise<CommandResult> =>
  await executeCommand(s.db.app, s.business, who.presented, 'api', body as never);

/** The agent picks the reservation up, or the refusal's code. */
const tryPickup = async (reservationId: unknown): Promise<string> =>
  codeOf(
    await asAgent(s, {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId,
      leaseSeconds: 600,
    }),
  );

/** Leases taken on the ticket's runs: each one a run that was picked up. */
const leasesOn = async (ticket: string): Promise<number> =>
  (
    await s.db.admin.execute<{ n: number }>(
      `select count(*)::int as n from public.leases l
         join public.planned_runs r on r.business_id = l.business_id and r.id = l.run_id
        where l.business_id = $1 and r.task_id = $2`,
      [s.business, ticket],
    )
  )[0]?.n ?? 0;

/** One more person holding decide on the business, delegable, to approve another's restart. */
const secondApprover = async (): Promise<Member> => {
  const member = await enrol(s.db.app, s.business, `wf7-second-${randomUUID()}`);
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await grantTo(tx, member, action, undefined, true);
    }
  });
  return member;
};

it('WF-7 twice failed: a run proposed before the second failure is not picked up while the map owner is asked', async () => {
  const ticket = await researchOnMap(s, owner, 'wf7 proposed before the stop');
  await failedRun(s, ticket);
  // Two starts by the decider, both before the second failure: neither is stopped yet.
  const second = appliedDetail(await start(s, ticket), 'task.propose');
  const third = appliedDetail(await start(s, ticket), 'task.propose');
  await fail(s, await pickup(s, (await approve(s, second))['reservationId']));
  // The second failure stops the ticket: the owner is asked.
  expect(await asksOn(s, ticket)).toStrictEqual([
    { recipient: owner.personId, state: 'open', closedBy: null },
  ]);
  expect(await leasesOn(ticket)).toBe(2);
  // The third run, proposed before the stop, is approved and picked up after it.
  const decided = await as(await approverOf(s), approveBody(third));
  if (codeOf(decided) === 'applied') {
    await tryPickup((decided as { detail?: Detail }).detail?.['reservationId']);
  }
  // Stopped means no third run begins until the owner decides.
  expect(await leasesOn(ticket)).toBe(2);
  expect(await asksOn(s, ticket)).toStrictEqual([
    { recipient: owner.personId, state: 'open', closedBy: null },
  ]);
}, 240_000);

it('WF-7 twice failed: a restart by another person with decide waits on the map owner too', async () => {
  const ticket = await researchOnMap(s, owner, 'wf7 restarted past the stop');
  await failedRun(s, ticket);
  const { runId, picked } = await runOn(s, ticket);
  await fail(s, picked);
  expect(await asksOn(s, ticket)).toStrictEqual([
    { recipient: owner.personId, state: 'open', closedBy: null },
  ]);
  const [lineage] = await s.db.admin.execute<{ id: string }>(
    `select v.lineage_id::text as id from public.planned_runs r
       join public.proposal_versions v on v.business_id = r.business_id and v.id = r.version_id
      where r.business_id = $1 and r.id = $2`,
    [s.business, runId],
  );
  // The approver, who holds decide on the ticket and is not its map's owner, cancels and restarts.
  const approver = await approverOf(s);
  const cancelled = await as(approver, {
    command: 'task.cancel',
    operationId: randomUUID(),
    recordId: ticket,
    lineageId: lineage?.id,
    reason: 'run it again',
  });
  expect(codeOf(cancelled)).toBe('applied');
  const restarted = await as(approver, {
    command: 'task.restart',
    operationId: randomUUID(),
    recordId: ticket,
    lineageId: lineage?.id,
  });
  if (codeOf(restarted) === 'applied') {
    const decided = await as(await secondApprover(), {
      ...approveBody((restarted as { detail?: Detail }).detail ?? {}),
    });
    if (codeOf(decided) === 'applied') {
      await tryPickup((decided as { detail?: Detail }).detail?.['reservationId']);
    }
  }
  // Stopped means no third run begins until the owner decides.
  expect(await leasesOn(ticket)).toBe(2);
  expect(await asksOn(s, ticket)).toStrictEqual([
    { recipient: owner.personId, state: 'open', closedBy: null },
  ]);
}, 240_000);
