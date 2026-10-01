// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7 (#640) "Twice failed, it stops": a run approved before the second
// failure and picked up after it begins only on a word given after the stop.
// An approval given before the stop is not the map owner's decision, nor a
// decide-holder's start: with an owner the run waits and the owner's item
// stays open; with none the run waits and no lift is recorded. The shared
// cases are in wf-7-failures.ts. On the real commands against Postgres.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  approveBody,
  asAgent,
  asPerson,
  codeOf,
  freshPurpose,
  openSchedules,
  pickup,
  proposeBody,
  revisionOf,
  type Detail,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import {
  approve,
  asksOn,
  charter,
  commentsOn,
  fail,
  researchOnMap,
  start,
} from './wf-7-failures.ts';

/** Every case needs the database; without one the file is skipped. */
const noDatabase = databaseUrlFromEnvironment() === undefined;
const it = noDatabase ? vitestIt.skip : vitestIt;

let s: Schedules;
let owner: Member;

beforeAll(async () => {
  if (noDatabase) return;
  s = await openSchedules('wf7stoppickup', 1_000_000);
  owner = await charter(s, 'map-owner-approves');
  // The map's owner also approves runs: decide and what pickup mints from, delegable.
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (const action of ['decide', 'assign', 'comment'] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await grantTo(tx, owner, action, undefined, true);
    }
  });
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

/**
 * Run 1 failed, then runs 2 and 3 proposed and both approved, run 3 by
 * `approveThird`. Run 1's version opens the ticket's envelope wide enough to
 * hold the two approvals at once.
 */
const twoApproved = async (
  ticket: string,
  approveThird: (proposal: Detail) => Promise<Detail>,
): Promise<{ second: Detail; third: Detail }> => {
  const body = proposeBody(ticket, await revisionOf(s, ticket), {
    purpose: freshPurpose(),
    maximumMinor: 10_000,
  });
  const first = appliedDetail(await asPerson(s, body), 'task.propose');
  await fail(s, await pickup(s, (await approve(s, first))['reservationId']));
  const second = appliedDetail(await start(s, ticket), 'task.propose');
  const third = appliedDetail(await start(s, ticket), 'task.propose');
  return { second: await approve(s, second), third: await approveThird(third) };
};

it("WF-7 twice failed: the map owner's approval given before the stop does not begin a run after it", async () => {
  const ticket = await researchOnMap(s, owner, 'wf7 owner approved before the stop');
  const { second, third } = await twoApproved(ticket, async (proposal) =>
    appliedDetail(await as(owner, approveBody(proposal)), 'task.decide'),
  );
  await fail(s, await pickup(s, second['reservationId']));
  const asked = [{ recipient: owner.personId, state: 'open', closedBy: null }];
  expect(await asksOn(s, ticket)).toStrictEqual(asked);
  // The owner has not looked at the stop: their earlier approval is not their decision on it.
  await tryPickup(third['reservationId']);
  expect(await leasesOn(ticket)).toBe(2);
  expect(await asksOn(s, ticket)).toStrictEqual(asked);
}, 240_000);

it("WF-7 twice failed with no map owner: an approval given before the stop does not lift it at pickup", async () => {
  const ticket = await researchOnMap(s, owner, 'wf7 ownerless approved before the stop');
  await s.db.admin.execute(
    `update public.records m set data = m.data - 'map_owner'
       from public.records t
      where t.business_id = $1 and t.id = $2
        and m.business_id = t.business_id and m.id = t.uuid_4`,
    [s.business, ticket],
  );
  const { second, third } = await twoApproved(ticket, async (proposal) => await approve(s, proposal));
  await fail(s, await pickup(s, second['reservationId']));
  const said = async () => (await commentsOn(s, ticket)).map((comment) => comment.body);
  const before = await said();
  // No decide-holder has started it since the stop: the run waits and nothing records a lift.
  await tryPickup(third['reservationId']);
  expect(await leasesOn(ticket)).toBe(2);
  expect(await said()).toStrictEqual(before);
}, 240_000);
