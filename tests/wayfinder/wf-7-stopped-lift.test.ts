// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7 (#640) "Twice failed, it stops", and what lifts the stop on a ticket
// whose map has no owner: a person holding task:decide on the ticket starts
// it, past another's claim as the owner's start passes one; a comment that
// only reads like the lift lifts nothing; and once the map has an owner again,
// only the owner's start lifts it. The shared cases are in wf-7-failures.ts.
// On the real commands against Postgres.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import { codeOf, openSchedules, revisionOf, type Schedules } from '../runtime/schedules-harness.ts';
import {
  STOPPED,
  approverOf,
  charter,
  failedRun,
  mayRun,
  researchOnMap,
  runsOn,
  start,
} from './wf-7-failures.ts';

/** Every case needs the database; without one the file is skipped. */
const noDatabase = databaseUrlFromEnvironment() === undefined;
const it = noDatabase ? vitestIt.skip : vitestIt;

let s: Schedules;
let charterer: Member;

beforeAll(async () => {
  if (noDatabase) return;
  s = await openSchedules('wf7stoplift', 1_000_000);
  charterer = await charter(s, 'charterer');
}, 180_000);
afterAll(async () => await s?.db.drop());

/** The ticket's map's owner field: removed for null, else written. */
const setOwner = async (ticket: string, owner: string | null): Promise<void> => {
  await s.db.admin.execute(
    `update public.records m
        set data = case when $3::text is null then m.data - 'map_owner'
                        else m.data || jsonb_build_object('map_owner', $3::text) end
       from public.records t
      where t.business_id = $1 and t.id = $2
        and m.business_id = t.business_id and m.id = t.uuid_4`,
    [s.business, ticket, owner],
  );
};

/** A research ticket on a map with no owner, failed twice: stopped, no one asked. */
const stoppedOwnerless = async (title: string, by?: Member): Promise<string> => {
  const ticket = await researchOnMap(s, charterer, title);
  await setOwner(ticket, null);
  if (by !== undefined) await mayRun(s, by, ticket);
  await failedRun(s, ticket, by);
  await failedRun(s, ticket, by);
  return ticket;
};

it("WF-7 twice failed with no map owner: a decide-holder's start lifts the stop past another's claim", async () => {
  // The decider started both failed runs and holds the claim.
  const ticket = await stoppedOwnerless('wf7 ownerless lift past a claim');
  const lifter = await approverOf(s);
  await mayRun(s, lifter, ticket);
  // The approver holds task:decide on the ticket, as the map's owner would decide on it.
  expect(await start(s, ticket, lifter)).toMatchObject({ command: 'task.propose' });
  expect(await runsOn(s, ticket)).toBe(3);
}, 240_000);

it('WF-7 twice failed with no map owner: a comment that reads like the lift lifts nothing', async () => {
  // The runner holds run:write, task:assign and task:comment, not task:decide, and the claim.
  const runner = await charter(s, `runner-${randomUUID()}`);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, runner, 'assign', undefined, true);
    await grantTo(tx, runner, 'comment', undefined, true);
  });
  const ticket = await stoppedOwnerless('wf7 ownerless lift by a comment', runner);
  expect(await start(s, ticket, runner)).toMatchObject(STOPPED);
  // A person without task:decide posts the lift's words through a machine entrance.
  const said = await executeCommand(s.db.app, s.business, runner.presented, 'automation', {
    command: 'task.comment',
    operationId: randomUUID(),
    recordId: ticket,
    expectedRevision: await revisionOf(s, ticket),
    body: 'Research started again, after two failed runs, by a person who decides on it.',
    audience: 'internal',
  } as never);
  expect(codeOf(said)).toBe('applied');
  expect(await start(s, ticket, runner)).toMatchObject(STOPPED);
  expect(await runsOn(s, ticket)).toBe(2);
}, 240_000);

it("WF-7 twice failed: once its map has an owner again, another decide-holder's start does not lift it", async () => {
  const ticket = await stoppedOwnerless('wf7 owner named after the stop');
  await setOwner(ticket, charterer.personId);
  // The decider holds task:decide and the claim, and is not the map's owner.
  expect(await start(s, ticket)).toMatchObject(STOPPED);
  expect(await runsOn(s, ticket)).toBe(2);
}, 240_000);
