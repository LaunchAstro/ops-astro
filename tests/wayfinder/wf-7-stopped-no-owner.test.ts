// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7 (#640) "Twice failed, it stops", whether or not the map has an owner.
// With no owner to ask (or no map), the second failure stops the ticket all
// the same: no one is asked, a start by a person without task:decide on the
// ticket is refused and writes nothing, a decide-holder's start lifts it, and
// two more failures stop it again. Another ticket's or another business's
// decide-holder lifts nothing. The shared cases are in wf-7-failures.ts. On the
// real commands against Postgres.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  asPerson,
  codeOf,
  freshPurpose,
  openSchedules,
  proposeBody,
  revisionOf,
  seedSchedules,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import {
  STOPPED,
  asksOn,
  charter,
  commentsOn,
  fail,
  failedRun,
  mayRun,
  researchOnMap,
  runOn,
  runsOn,
  start,
} from './wf-7-failures.ts';

/** Every case needs the database; without one the file is skipped. */
const noDatabase = databaseUrlFromEnvironment() === undefined;
const it = noDatabase ? vitestIt.skip : vitestIt;

let s: Schedules;
let charterer: Member;
let other: Schedules;

beforeAll(async () => {
  if (noDatabase) return;
  s = await openSchedules('wf7noowner', 1_000_000);
  charterer = await charter(s, 'charterer');
  other = await seedSchedules(s.db, 'wf7noowner-b', 1_000_000);
}, 180_000);
afterAll(async () => await s?.db.drop());

/** A research ticket on a map whose owner field is empty. */
const onOwnerlessMap = async (title: string): Promise<string> => {
  const ticket = await researchOnMap(s, charterer, title);
  await s.db.admin.execute(
    `update public.records m set data = m.data - 'map_owner'
       from public.records t
      where t.business_id = $1 and t.id = $2
        and m.business_id = t.business_id and m.id = t.uuid_4`,
    [s.business, ticket],
  );
  return ticket;
};

/** A research ticket on no map at all, the decider holding run:write on it. */
const onNoMap = async (title: string): Promise<string> => {
  const created = await asPerson(s, {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title },
    taskType: 'research',
  });
  appliedDetail(created, 'task.create');
  const ticket = String((created as { recordId: string }).recordId);
  await mayRun(s, s.decider, ticket);
  return ticket;
};

/** What a refused start must leave as it was: runs, revision, comments, asks. */
const written = async (ticket: string): Promise<unknown> => ({
  runs: await runsOn(s, ticket),
  revision: await revisionOf(s, ticket),
  said: await commentsOn(s, ticket),
  asks: await asksOn(s, ticket),
});

/** A person with run:write on the ticket and task:write, but not task:decide. */
const runnerOn = async (ticket: string): Promise<Member> => {
  const runner = await charter(s, `runner-${randomUUID()}`);
  await mayRun(s, runner, ticket);
  return runner;
};

/** The start is refused stopped, and nothing about the ticket changed. */
const refusedStopped = async (ticket: string, by: Member): Promise<void> => {
  const before = await written(ticket);
  expect(await start(s, ticket, by)).toMatchObject(STOPPED);
  expect(await written(ticket)).toStrictEqual(before);
};

const reports = async (ticket: string): Promise<number> =>
  (await commentsOn(s, ticket)).filter((said) => /failed twice/u.test(said.body)).length;

it('WF-7 twice failed with no map owner: a start without task:decide is refused and writes nothing', async () => {
  const ticket = await onOwnerlessMap('wf7 ownerless refused');
  await failedRun(s, ticket);
  await failedRun(s, ticket);
  expect(await asksOn(s, ticket)).toStrictEqual([]);
  await refusedStopped(ticket, await runnerOn(ticket));
  expect(await runsOn(s, ticket)).toBe(2);
}, 180_000);

it('WF-7 twice failed with no map owner: a person holding task:decide starts it and the run begins', async () => {
  const ticket = await onOwnerlessMap('wf7 ownerless lifted');
  await failedRun(s, ticket);
  await failedRun(s, ticket);
  // The decider holds task:decide on the ticket: their start lifts the stop.
  const { picked } = await runOn(s, ticket);
  expect(picked['leaseId']).toBeDefined();
  expect(await runsOn(s, ticket)).toBe(3);
  // No one was asked, before or after.
  expect(await asksOn(s, ticket)).toStrictEqual([]);
}, 180_000);

it('WF-7 twice failed with no map owner: two more failures after the lift stop it again', async () => {
  const ticket = await onOwnerlessMap('wf7 ownerless again');
  await failedRun(s, ticket);
  await failedRun(s, ticket);
  const runner = await runnerOn(ticket);
  await fail(s, (await runOn(s, ticket)).picked);
  // Once since the lift is not twice: the decider starts it, and it fails again.
  await failedRun(s, ticket);
  expect(await reports(ticket)).toBe(2);
  await refusedStopped(ticket, runner);
  expect(await runsOn(s, ticket)).toBe(4);
}, 240_000);

it("WF-7 twice failed with no map owner isolation: another ticket's or business's decide-holder lifts nothing", async () => {
  const ticket = await onOwnerlessMap('wf7 ownerless crossing');
  await failedRun(s, ticket);
  await failedRun(s, ticket);
  // Ticket to ticket: task:decide on another ticket of the business is not on this one.
  const elsewhere = await runnerOn(ticket);
  const another = await onOwnerlessMap('wf7 ownerless elsewhere');
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, elsewhere, 'decide', { kind: 'record', id: another });
  });
  await refusedStopped(ticket, elsewhere);
  // Business to business: the other business's decider, here and from there.
  const before = await written(ticket);
  const body = proposeBody(ticket, await revisionOf(s, ticket), { purpose: freshPurpose() });
  const here = await executeCommand(s.db.app, s.business, other.decider.presented, 'api', {
    ...body,
  } as never);
  expect(codeOf(here)).not.toBe('applied');
  const there = await executeCommand(other.db.app, other.business, other.decider.presented, 'api', {
    ...body,
  } as never);
  expect(codeOf(there)).not.toBe('applied');
  expect(await written(ticket)).toStrictEqual(before);
  // Still stopped.
  await refusedStopped(ticket, await runnerOn(ticket));
}, 240_000);

it('WF-7 twice failed with no map: refused without task:decide, then a decide-holder starts it', async () => {
  const ticket = await onNoMap('wf7 no map stops');
  await failedRun(s, ticket);
  await failedRun(s, ticket);
  expect(await asksOn(s, ticket)).toStrictEqual([]);
  await refusedStopped(ticket, await runnerOn(ticket));
  await runOn(s, ticket);
  expect(await runsOn(s, ticket)).toBe(3);
  expect(await asksOn(s, ticket)).toStrictEqual([]);
}, 240_000);
