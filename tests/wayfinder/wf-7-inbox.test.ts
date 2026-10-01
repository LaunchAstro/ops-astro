// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7 (#640) "Twice failed, it stops, reports on the ticket and raises one
// inbox item to the map's owner", and the tracked action `inbox item raised
// (waiting run)`: a system write under the worker lease, in the writing
// transaction. The run is main's proposal, approval and pickup on a research
// ticket of a map; the agent hands it back failed. INB-1's raise
// (`raiseRunSettled`) tells the launcher of each failed run; the second failed
// run on the ticket also tells the map's owner, once, and says so on the
// ticket. On the real commands against Postgres.

import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { type Member } from '../commands/fixture.ts';
import {
  asAgent,
  codeOf,
  handbackBody,
  openSchedules,
  seedSchedules,
  type Schedules,
} from '../runtime/schedules-harness.ts';

import {
  approverOf,
  charter,
  commentsOn,
  fail,
  failedRun,
  itemsOf,
  itemsOn,
  researchOnMap,
  runOn,
} from './wf-7-failures.ts';

/** Every case needs the database; without one the file is skipped. */
const noDatabase = databaseUrlFromEnvironment() === undefined;
const it = noDatabase ? vitestIt.skip : vitestIt;

let s: Schedules;
let owner: Member;
let other: Schedules;
let otherOwner: Member;

beforeAll(async () => {
  if (noDatabase) return;
  s = await openSchedules('wf7inbox', 1_000_000);
  owner = await charter(s, 'map-owner');
  other = await seedSchedules(s.db, 'wf7inbox-b', 1_000_000);
  otherOwner = await charter(other, 'map-owner-b');
}, 180_000);
afterAll(async () => await s?.db.drop());

it('WF-7 waiting item under the lease: a failed research run raises one waiting item to its launcher, in the handback, under the worker lease', async () => {
  const ticket = await researchOnMap(s, owner, 'wf7 waiting');
  const { runId, picked } = await runOn(s, ticket);
  // A handback the runtime refuses (a stale fence) settles nothing and raises nothing.
  const stale = await asAgent(
    s,
    { ...handbackBody(picked), fence: Number(picked['fence']) + 1, outcome: 'failed' },
    String(picked['credential']),
  );
  expect(codeOf(stale)).toBe('LEASE_NOT_OWNED');
  expect(await itemsOn(s, ticket)).toStrictEqual([]);
  // The agent holds the lease and no person's grant on the inbox: the raise is the system's.
  await fail(s, picked);
  const launcher = (await approverOf(s)).personId;
  expect(await itemsOn(s, ticket)).toStrictEqual([
    { recipient: launcher, reason: 'waiting_run', factKind: 'planned_run', factId: runId },
  ]);
  // Once failed is not twice: the map's owner is not told, and the ticket carries no report.
  expect(await itemsOf(s, owner.personId)).toBe(0);
  expect(await commentsOn(s, ticket)).toStrictEqual([]);
}, 120_000);

it("WF-7 twice failed: the second failed run on a research ticket stops, reports on the ticket and raises one inbox item to the map's owner", async () => {
  const ticket = await researchOnMap(s, owner, 'wf7 twice');
  const first = await failedRun(s, ticket);
  const second = await failedRun(s, ticket);
  const launcher = (await approverOf(s)).personId;
  expect(await itemsOn(s, ticket)).toStrictEqual([
    { recipient: launcher, reason: 'waiting_run', factKind: 'planned_run', factId: first },
    { recipient: launcher, reason: 'waiting_run', factKind: 'planned_run', factId: second },
    { recipient: owner.personId, reason: 'waiting_run', factKind: 'record', factId: ticket },
  ]);
  const said = await commentsOn(s, ticket);
  expect(said).toHaveLength(1);
  expect(said[0]).toMatchObject({ type: 'system', audience: 'internal' });
  expect(said[0]?.body).toMatch(/failed twice/u);
}, 180_000);

it("WF-7 twice failed isolation: a ticket's failures are its own, counted in its own business and told only to its own map's owner", async () => {
  // A map owner of this case's own, so the earlier cases' items are not counted here.
  const mine = await charter(s, 'map-owner-crossing');
  // Business to business: one failure each on two businesses' tickets is not twice.
  const here = await researchOnMap(s, mine, 'wf7 crossing here');
  const there = await researchOnMap(other, otherOwner, 'wf7 crossing there');
  await failedRun(s, here);
  await failedRun(other, there);
  expect(await itemsOf(s, mine.personId)).toBe(0);
  expect(await itemsOf(other, otherOwner.personId)).toBe(0);
  // Ticket to ticket, in one business: two tickets failing once each are not twice either.
  const beside = await researchOnMap(s, mine, 'wf7 crossing beside');
  await failedRun(s, beside);
  expect(await itemsOf(s, mine.personId)).toBe(0);
  // Twice on one ticket over there tells that business's owner alone.
  await failedRun(other, there);
  expect((await itemsOn(other, there)).map((item) => item.recipient)).toContain(
    otherOwner.personId,
  );
  expect(await itemsOf(s, mine.personId)).toBe(0);
  // Person to person: the launcher is told of each run, never as the map's owner.
  const launcher = (await approverOf(other)).personId;
  expect(
    (await itemsOn(other, there)).filter(
      (item) => item.recipient === launcher && item.factKind === 'record',
    ),
  ).toStrictEqual([]);
}, 180_000);
