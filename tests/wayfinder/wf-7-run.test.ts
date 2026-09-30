// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7 (#640) "`run started (research)` · `run:write`, yes inside its
// delegation". A person starts a research run by pressing Run, which is the
// proposal on the ticket (`task.propose`): on a research ticket it asks
// `run:write` on the ticket as well as the row's `task:write`. An agent
// proposes only where its delegation reaches `run` (MP-6-2's pickup mints it
// only for a person holding `run:write`, write alone). Other tasks are
// unchanged. On the real commands against Postgres.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  appliedDetail,
  approve,
  asAgent,
  asPerson,
  codeOf,
  createTask,
  freshPurpose,
  openSchedules,
  pickup,
  propose,
  proposeBody,
  revisionOf,
  type Schedules,
} from '../runtime/schedules-harness.ts';

let s: Schedules;

const researchTicket = async (title: string): Promise<string> => {
  const outcome = await asPerson(s, {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title },
    taskType: 'research',
  });
  appliedDetail(outcome, 'task.create');
  return String((outcome as { recordId: string }).recordId);
};

const grantRunWrite = async (ticket: string): Promise<void> => {
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'write', { kind: 'record', id: ticket }, false, 'run');
  });
};

const runsOn = async (ticket: string): Promise<number> =>
  (
    await s.db.admin.execute<{ n: number }>(
      'select count(*)::int as n from public.planned_runs where business_id = $1 and task_id = $2',
      [s.business, ticket],
    )
  )[0]?.n ?? 0;

const proposeAsPerson = async (ticket: string) =>
  await asPerson(s, proposeBody(ticket, await revisionOf(s, ticket), { purpose: freshPurpose() }));

/** Every case needs the database; without one the file is skipped. */
const noDatabase = databaseUrlFromEnvironment() === undefined;
const it = noDatabase ? vitestIt.skip : vitestIt;

beforeAll(async () => {
  if (!noDatabase) s = await openSchedules('wf7run', 1_000_000);
}, 180_000);
afterAll(async () => await s?.db.drop());

it('WF-7 refusal run:write: a person holding task:write but not run:write cannot start a research run', async () => {
  const ticket = await researchTicket('wf7 no run write');
  expect(codeOf(await proposeAsPerson(ticket))).toBe('SCOPE_NOT_GRANTED');
  expect(await runsOn(ticket)).toBe(0);
  // The same person proposes on a task that is not research, as before.
  const plain = await createTask(s, 'wf7 plain task');
  appliedDetail(await proposeAsPerson(plain), 'task.propose');
}, 60_000);

it('WF-7 run started (research): run:write on the ticket starts it', async () => {
  const ticket = await researchTicket('wf7 run write held');
  await grantRunWrite(ticket);
  appliedDetail(await proposeAsPerson(ticket), 'task.propose');
  expect(await runsOn(ticket)).toBe(1);
  // The grant is the ticket's: another research ticket stays refused.
  const other = await researchTicket('wf7 run write elsewhere');
  expect(codeOf(await proposeAsPerson(other))).toBe('SCOPE_NOT_GRANTED');
  expect(await runsOn(other)).toBe(0);
}, 60_000);

it('WF-7 refusal run:write: an agent whose delegation does not reach run cannot start one, though its person now holds it', async () => {
  // Picked up while the person held no run:write, so the delegation is the
  // task alone; the ticket turns research after, and the person is granted
  // run:write after: the delegation's own reach is what refuses.
  const task = await createTask(s, 'wf7 agent task-only');
  const purpose = freshPurpose();
  const proposal = await propose(s, task, { purpose });
  const picked = await pickup(s, (await approve(s, proposal))['reservationId']);
  appliedDetail(
    await asPerson(s, {
      command: 'task.set_type',
      operationId: randomUUID(),
      recordId: task,
      expectedRevision: await revisionOf(s, task),
      taskType: 'research',
    }),
    'task.set_type',
  );
  await grantRunWrite(task);
  const before = await runsOn(task);
  const answer = await asAgent(
    s,
    proposeBody(task, await revisionOf(s, task), { purpose }),
    String(picked['credential']),
  );
  expect(codeOf(answer)).toBe('DELEGATION_OUT_OF_PURPOSE');
  expect(await runsOn(task)).toBe(before);
}, 120_000);
