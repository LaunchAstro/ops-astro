// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7 (#640) "Twice failed, it stops", for a run whose lease lapsed before
// the stop. A task holds one live lease, so the run that fails the second
// time was taken up over that lapsed lease: the earlier run is still claimed,
// its hold abandoned, and nobody is working it. The stop leaves it on its
// lineage, so taking it up again is a run that begins on an approval given
// before the stop: refused while the ticket is stopped, and still not one
// that begins once the map owner starts the ticket again. The shared cases are
// in wf-7-failures.ts. On the real commands against Postgres.

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
  STOPPED,
  approve,
  asksOn,
  charter,
  fail,
  mayRun,
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
  s = await openSchedules('wf7stoplapsed', 1_000_000);
  owner = await charter(s, 'map-owner-lapsed');
  // The map's owner also approves runs: decide and what a claim mints from, delegable.
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

/** Leases taken on the ticket's runs: each one a run that was taken up. */
const leasesOn = async (ticket: string): Promise<number> =>
  (
    await s.db.admin.execute<{ n: number }>(
      `select count(*)::int as n from public.leases l
         join public.planned_runs r on r.business_id = l.business_id and r.id = l.run_id
        where l.business_id = $1 and r.task_id = $2`,
      [s.business, ticket],
    )
  )[0]?.n ?? 0;

/** The agent takes the reservation up, or is refused. */
const takeUp = async (reservationId: unknown): Promise<CommandResult> =>
  await asAgent(s, {
    command: 'task.pickup',
    operationId: randomUUID(),
    reservationId,
    leaseSeconds: 600,
  });

/** The server's clock, moved by the server: a lease and its delegation lapse together. */
const lapse = async (picked: Detail): Promise<void> => {
  await s.db.admin.execute(
    `update public.leases set expires_at = now() - interval '1 second' where id = $1`,
    [picked['leaseId']],
  );
  await s.db.admin.execute(
    `update public.delegations
        set granted_at = now() - interval '3 seconds', expires_at = now() - interval '1 second'
      where id = $1`,
    [picked['delegationId']],
  );
};

const ownerStarts = async (ticket: string): Promise<CommandResult> =>
  await as(owner, proposeBody(ticket, await revisionOf(s, ticket), { purpose: freshPurpose() }));

/**
 * Run 1 failed. Runs 2 and 3 approved, run 3 by the map's owner. Run 3 is
 * taken up and its agent goes quiet; run 2 is taken up over the lapsed lease
 * and fails, so the ticket stops and the owner is asked.
 */
const lapsedThenStopped = async (title: string): Promise<{ ticket: string; third: Detail }> => {
  const ticket = await researchOnMap(s, owner, title);
  await mayRun(s, owner, ticket);
  const body = proposeBody(ticket, await revisionOf(s, ticket), {
    purpose: freshPurpose(),
    maximumMinor: 10_000,
  });
  const first = appliedDetail(await asPerson(s, body), 'task.propose');
  await fail(s, await pickup(s, (await approve(s, first))['reservationId']));
  const second = await approve(s, appliedDetail(await start(s, ticket), 'task.propose'));
  const proposed = appliedDetail(await start(s, ticket), 'task.propose');
  const third = appliedDetail(await as(owner, approveBody(proposed)), 'task.decide');
  await lapse(await pickup(s, third['reservationId']));
  await fail(s, await pickup(s, second['reservationId']));
  expect(await asksOn(s, ticket)).toStrictEqual([
    { recipient: owner.personId, state: 'open', closedBy: null },
  ]);
  return { ticket, third };
};

it("WF-7 twice failed: a run whose lease lapsed before the stop is not taken up again while stopped, on the map owner's earlier approval", async () => {
  const { ticket, third } = await lapsedThenStopped('wf7 lapsed run while stopped');
  const leases = await leasesOn(ticket);
  // The owner approved run 3 before the stop: that is not their decision on it.
  expect(await takeUp(third['reservationId'])).toMatchObject(STOPPED);
  expect(await leasesOn(ticket)).toBe(leases);
  expect(await asksOn(s, ticket)).toStrictEqual([
    { recipient: owner.personId, state: 'open', closedBy: null },
  ]);
}, 240_000);

it("WF-7 twice failed: after the map owner's start, a run whose lease lapsed before the stop is not taken up again", async () => {
  const { ticket, third } = await lapsedThenStopped('wf7 lapsed run after the owner starts');
  // The owner decides on one run: their start clears the ask.
  expect(codeOf(await ownerStarts(ticket))).toBe('applied');
  const leases = await leasesOn(ticket);
  expect(codeOf(await takeUp(third['reservationId']))).not.toBe('applied');
  expect(await leasesOn(ticket)).toBe(leases);
}, 240_000);
