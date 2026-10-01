// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7 (#640) "Twice failed, it stops": after the second failed run a research
// ticket waits on its map's owner. A new run waits, the owner's start clears
// the item, two more failures ask again, a map with no owner asks no one (and
// stops all the same: wf-7-stopped-no-owner.test.ts), and
// another map's owner or another business cannot start the stopped ticket.
// The shared cases are in wf-7-failures.ts. On the real commands against Postgres.

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
let owner: Member;
let other: Schedules;
let otherOwner: Member;

beforeAll(async () => {
  if (noDatabase) return;
  s = await openSchedules('wf7stopped', 1_000_000);
  owner = await charter(s, 'map-owner');
  other = await seedSchedules(s.db, 'wf7stopped-b', 1_000_000);
  otherOwner = await charter(other, 'map-owner-b');
}, 180_000);
afterAll(async () => await s?.db.drop());

it('WF-7 twice failed: after the second failure, a new run waits on the map owner', async () => {
  const ticket = await researchOnMap(s, owner, 'wf7 waits on owner');
  await mayRun(s, owner, ticket);
  await failedRun(s, ticket);
  await failedRun(s, ticket);
  // The decider's third start is refused and writes nothing: no run, no claim, no revision.
  const before = await revisionOf(s, ticket);
  expect(await start(s, ticket)).toMatchObject(STOPPED);
  expect(await runsOn(s, ticket)).toBe(2);
  expect(await revisionOf(s, ticket)).toBe(before);
  expect(await asksOn(s, ticket)).toStrictEqual([
    { recipient: owner.personId, state: 'open', closedBy: null },
  ]);
  // The map's owner starts it: that is their decision, and it closes their item.
  await runOn(s, ticket, owner);
  expect(await runsOn(s, ticket)).toBe(3);
  expect(await asksOn(s, ticket)).toStrictEqual([
    { recipient: owner.personId, state: 'cleared', closedBy: owner.personId },
  ]);
}, 180_000);

it('WF-7 twice failed: two more failures after the owner clears the item ask again', async () => {
  const ticket = await researchOnMap(s, owner, 'wf7 asks again');
  await mayRun(s, owner, ticket);
  await failedRun(s, ticket);
  await failedRun(s, ticket);
  // The owner looks and runs it again; it fails a third time, once since their decision.
  await failedRun(s, ticket, owner);
  expect(await asksOn(s, ticket)).toStrictEqual([
    { recipient: owner.personId, state: 'cleared', closedBy: owner.personId },
  ]);
  expect(await commentsOn(s, ticket)).toHaveLength(1);
  // Once since is not twice: the decider may start it, and its failure is the second since.
  await failedRun(s, ticket);
  expect(await asksOn(s, ticket)).toStrictEqual([
    { recipient: owner.personId, state: 'cleared', closedBy: owner.personId },
    { recipient: owner.personId, state: 'open', closedBy: null },
  ]);
  const said = await commentsOn(s, ticket);
  expect(said.map((comment) => comment.type)).toStrictEqual(['system', 'system']);
  // And it stops again.
  expect(await start(s, ticket)).toMatchObject(STOPPED);
  expect(await runsOn(s, ticket)).toBe(4);
}, 240_000);

it('WF-7 twice failed with no map owner: the report says no one was asked, and a start without task:decide is refused', async () => {
  const created = await asPerson(s, {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title: 'wf7 no map' },
    taskType: 'research',
  });
  const ticket = String(
    appliedDetail(created, 'task.create') && (created as { recordId: string }).recordId,
  );
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'write', { kind: 'record', id: ticket }, false, 'run');
  });
  await failedRun(s, ticket);
  await failedRun(s, ticket);
  const said = await commentsOn(s, ticket);
  expect(said).toHaveLength(1);
  expect(said[0]?.body).toMatch(/failed twice/u);
  expect(said[0]?.body).not.toMatch(/owner has been asked/u);
  expect(await asksOn(s, ticket)).toStrictEqual([]);
  // No owner to ask, and stopped all the same: a third start without task:decide is refused.
  const runner = await charter(s, 'runner-no-map');
  await mayRun(s, runner, ticket);
  expect(await start(s, ticket, runner)).toMatchObject(STOPPED);
  expect(await runsOn(s, ticket)).toBe(2);
}, 180_000);

it("WF-7 twice failed isolation: another map's owner and another business's cannot start a stopped ticket", async () => {
  const ticket = await researchOnMap(s, owner, 'wf7 stopped crossing');
  await failedRun(s, ticket);
  await failedRun(s, ticket);
  // Map to map, in one business: the owner of another map, holding run:write here, is refused.
  const elsewhere = await charter(s, 'map-owner-elsewhere');
  await researchOnMap(s, elsewhere, 'wf7 stopped elsewhere');
  await mayRun(s, elsewhere, ticket);
  expect(await start(s, ticket, elsewhere)).toMatchObject(STOPPED);
  // Business to business: the other business's map owner reaches nothing here or from there.
  expect(codeOf(await start(s, ticket, otherOwner))).not.toBe('applied');
  const fromThere = await executeCommand(
    other.db.app,
    other.business,
    otherOwner.presented,
    'api',
    {
      ...proposeBody(ticket, await revisionOf(s, ticket), { purpose: freshPurpose() }),
    } as never,
  );
  expect(codeOf(fromThere)).not.toBe('applied');
  // Still stopped, still waiting on this map's owner, and nothing written.
  expect(await runsOn(s, ticket)).toBe(2);
  expect(await asksOn(s, ticket)).toStrictEqual([
    { recipient: owner.personId, state: 'open', closedBy: null },
  ]);
  expect(await start(s, ticket)).toMatchObject(STOPPED);
}, 180_000);
