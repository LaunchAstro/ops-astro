// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7 (#640) "Twice failed, it stops": the stop withdraws the ticket's runs
// that no one has picked up, so the map owner's start is the one run that
// begins after it; and a lift that cannot be recorded on the ticket begins no
// run; and a successor the stopping handback asks for is withdrawn with them,
// so no one is asked to decide it. The shared cases are in wf-7-failures.ts. On the real commands against
// Postgres.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
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

beforeAll(async () => {
  if (noDatabase) return;
  s = await openSchedules('wf7stopwithdraw', 1_000_000);
  owner = await charter(s, 'map-owner');
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (const action of ['decide', 'assign', 'comment'] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await grantTo(tx, owner, action, undefined, true);
    }
  });
}, 180_000);
afterAll(async () => await s?.db.drop());

const leasesOn = async (ticket: string): Promise<number> =>
  (
    await s.db.admin.execute<{ n: number }>(
      `select count(*)::int as n from public.leases l
         join public.planned_runs r on r.business_id = l.business_id and r.id = l.run_id
        where l.business_id = $1 and r.task_id = $2`,
      [s.business, ticket],
    )
  )[0]?.n ?? 0;

/** The successor a failed handback asks for. */
const SUCCESSOR: Detail = {
  purpose: 'try_another_source',
  maximumMinor: 500,
  currency: 'AUD',
  payload: { instruction: 'try another source' },
  step: { kind: 'compose', payload: { tone: 'plain' } },
};

/** The open decision items on a gate, whoever holds them. */
const decisionsOn = async (gateId: unknown): Promise<number> =>
  (
    await s.db.admin.execute<{ n: number }>(
      `select count(*)::int as n from public.inbox_items
        where business_id = $1 and reason = 'decision' and fact_kind = 'gate'
          and fact_id = $2 and work_state = 'open'`,
      [s.business, gateId],
    )
  )[0]?.n ?? 0;

/** The state of the lineage a gate is on. */
const lineageOf = async (gateId: unknown): Promise<string | undefined> =>
  (
    await s.db.admin.execute<{ state: string }>(
      `select l.state from public.gates g
         join public.proposal_lineages l on l.business_id = g.business_id and l.id = g.lineage_id
        where g.business_id = $1 and g.id = $2`,
      [s.business, gateId],
    )
  )[0]?.state;

const ownerStarts = async (ticket: string): Promise<CommandResult> =>
  await executeCommand(s.db.app, s.business, owner.presented, 'api', {
    ...proposeBody(ticket, await revisionOf(s, ticket), { purpose: freshPurpose() }),
  } as never);

it("WF-7 twice failed: after the map owner's start, a run approved before the stop is not picked up", async () => {
  const ticket = await researchOnMap(s, owner, 'wf7 stale approval after the owner starts');
  await mayRun(s, owner, ticket);
  const body = proposeBody(ticket, await revisionOf(s, ticket), {
    purpose: freshPurpose(),
    maximumMinor: 10_000,
  });
  const first = appliedDetail(await asPerson(s, body), 'task.propose');
  await fail(s, await pickup(s, (await approve(s, first))['reservationId']));
  const second = await approve(s, appliedDetail(await start(s, ticket), 'task.propose'));
  const third = await approve(s, appliedDetail(await start(s, ticket), 'task.propose'));
  await fail(s, await pickup(s, second['reservationId']));
  // The owner decides on one run: their start clears the ask.
  expect(codeOf(await ownerStarts(ticket))).toBe('applied');
  expect(await asksOn(s, ticket)).toStrictEqual([
    { recipient: owner.personId, state: 'cleared', closedBy: owner.personId },
  ]);
  const picked = await asAgent(s, {
    command: 'task.pickup',
    operationId: randomUUID(),
    reservationId: third['reservationId'],
    leaseSeconds: 600,
  });
  expect(codeOf(picked)).not.toBe('applied');
  expect(await leasesOn(ticket)).toBe(2);
}, 240_000);

it('WF-7 twice failed with no map owner: a lift with no comment type to record it begins no run', async () => {
  const ticket = await researchOnMap(s, owner, 'wf7 lift with nowhere to record it');
  await s.db.admin.execute(
    `update public.records m set data = m.data - 'map_owner'
       from public.records t
      where t.business_id = $1 and t.id = $2
        and m.business_id = t.business_id and m.id = t.uuid_4`,
    [s.business, ticket],
  );
  await failedRun(s, ticket);
  await failedRun(s, ticket);
  // A key cannot change once written; this file's own database lifts that for the case.
  const rename = async (from: string, to: string): Promise<void> => {
    await s.db.admin.execute(
      'alter table public.record_types disable trigger record_types_immutable',
    );
    await s.db.admin.execute(
      'update public.record_types set key = $3 where business_id = $1 and key = $2',
      [s.business, from, to],
    );
    await s.db.admin.execute(
      'alter table public.record_types enable trigger record_types_immutable',
    );
  };
  await rename('task_comment', 'task_comment_gone');
  try {
    // The decider holds task:decide and the claim: only the missing record refuses it.
    expect(await start(s, ticket)).toMatchObject(STOPPED);
    expect(await runsOn(s, ticket)).toBe(2);
  } finally {
    await rename('task_comment_gone', 'task_comment');
  }
  expect(codeOf(await start(s, ticket))).toBe('applied');
  expect(await runsOn(s, ticket)).toBe(3);
}, 240_000);

it('WF-7 a failed handback that does not stop the ticket raises the decision on its successor', async () => {
  const ticket = await researchOnMap(s, owner, 'wf7 successor on a first failure');
  const settled = await fail(s, (await runOn(s, ticket)).picked, SUCCESSOR);
  expect(await lineageOf(settled['successorGateId'])).toBe('live');
  expect(await decisionsOn(settled['successorGateId'])).toBeGreaterThan(0);
  expect(await asksOn(s, ticket)).toStrictEqual([]);
}, 240_000);

it('WF-7 twice failed: the successor the stopping handback asks for is withdrawn and no one is asked to decide it', async () => {
  const ticket = await researchOnMap(s, owner, 'wf7 successor on the stopping failure');
  await failedRun(s, ticket);
  const settled = await fail(s, (await runOn(s, ticket)).picked, SUCCESSOR);
  expect(settled['successorGateId']).toStrictEqual(expect.any(String));
  expect(await lineageOf(settled['successorGateId'])).toBe('cancelled');
  expect(await decisionsOn(settled['successorGateId'])).toBe(0);
  expect(await asksOn(s, ticket)).toStrictEqual([
    { recipient: owner.personId, state: 'open', closedBy: null },
  ]);
}, 240_000);
