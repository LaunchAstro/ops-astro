// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7 (#640) "The run claims the ticket before any work; a claimed ticket is
// skipped." ORCH36 ruling P: starting a research run (`task.propose` on a
// research ticket, under `run:write`) claims the ticket in the same
// transaction, under the task lock, when nobody holds it; the starter's own
// claim passes; someone else's refuses `TRANSITION_NOT_PERMITTED` ['claimed']
// with nothing planned. An agent claims as its delegating person (the
// proposal's person subject). On the real commands against Postgres.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  asPerson,
  codeOf,
  freshPurpose,
  openSchedules,
  proposeBody,
  revisionOf,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

/** Every case needs the database; without one the file is skipped. */
const noDatabase = databaseUrlFromEnvironment() === undefined;
const it = noDatabase ? vitestIt.skip : vitestIt;

let s: Schedules;
let other: Member;

beforeAll(async () => {
  if (noDatabase) return;
  s = await openSchedules('wf7claim', 1_000_000);
  other = await enrol(s.db.app, s.business, 'wf7-other');
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (const action of ['read', 'write', 'assign'] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await grantTo(tx, other, action);
    }
  });
}, 180_000);
afterAll(async () => await s?.db.drop());

/** A research ticket both people may start: run:write on it for each. */
const researchTicket = async (title: string): Promise<string> => {
  const outcome = await asPerson(s, {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title },
    taskType: 'research',
  });
  const ticket = String(
    appliedDetail(outcome, 'task.create') && (outcome as { recordId: string }).recordId,
  );
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (const member of [s.decider, other]) {
      // oxlint-disable-next-line no-await-in-loop
      await grantTo(tx, member, 'write', { kind: 'record', id: ticket }, false, 'run');
    }
  });
  return ticket;
};

const as = async (member: Member, body: Readonly<Record<string, unknown>>) =>
  await executeCommand(s.db.app, s.business, member.presented, 'api', body as never);

const start = async (member: Member, ticket: string) =>
  await as(member, proposeBody(ticket, await revisionOf(s, ticket), { purpose: freshPurpose() }));

const facts = async (ticket: string): Promise<{ assignee: string | null; runs: number }> => {
  const rows = await s.db.admin.execute<{ assignee: string | null; runs: number }>(
    `select r.data->>'assignee' as assignee,
            (select count(*)::int from public.planned_runs p
              where p.business_id = r.business_id and p.task_id = r.id) as runs
       from public.records r where r.business_id = $1 and r.id = $2`,
    [s.business, ticket],
  );
  return { assignee: rows[0]?.assignee ?? null, runs: rows[0]?.runs ?? -1 };
};

it('WF-7 claim first: starting a research run claims the unclaimed ticket for its starter', async () => {
  const ticket = await researchTicket('wf7 claim unclaimed');
  const before = await revisionOf(s, ticket);
  appliedDetail(await start(s.decider, ticket), 'task.propose');
  expect(await facts(ticket)).toStrictEqual({ assignee: s.decider.personId, runs: 1 });
  expect(await revisionOf(s, ticket)).toBeGreaterThan(before);
}, 60_000);

it('WF-7 claim first: the starter’s own claim passes', async () => {
  const ticket = await researchTicket('wf7 claim own');
  appliedDetail(
    await asPerson(s, {
      command: 'task.claim',
      operationId: randomUUID(),
      recordId: ticket,
      expectedRevision: await revisionOf(s, ticket),
    }),
    'task.claim',
  );
  appliedDetail(await start(s.decider, ticket), 'task.propose');
  expect(await facts(ticket)).toStrictEqual({ assignee: s.decider.personId, runs: 1 });
}, 60_000);

it('WF-7 claim first: a ticket someone else claimed is refused, nothing planned and the claim kept', async () => {
  const ticket = await researchTicket('wf7 claim taken');
  appliedDetail(
    await as(other, {
      command: 'task.claim',
      operationId: randomUUID(),
      recordId: ticket,
      expectedRevision: await revisionOf(s, ticket),
    }),
    'task.claim',
  );
  const refusal = await start(s.decider, ticket);
  expect(refusal).toMatchObject({ code: 'TRANSITION_NOT_PERMITTED', names: ['claimed'] });
  expect(await facts(ticket)).toStrictEqual({ assignee: other.personId, runs: 0 });
}, 60_000);

it('WF-7 claim first: two starters racing on one ticket, exactly one wins and holds the claim', async () => {
  const ticket = await researchTicket('wf7 claim race');
  const answers = await Promise.all([start(s.decider, ticket), start(other, ticket)]);
  const codes = answers.map((answer) => codeOf(answer)).toSorted();
  expect(codes).toStrictEqual(['TRANSITION_NOT_PERMITTED', 'applied'].toSorted());
  const winner = codeOf(answers[0]!) === 'applied' ? s.decider : other;
  expect(await facts(ticket)).toStrictEqual({ assignee: winner.personId, runs: 1 });
}, 60_000);

it('WF-7 claim first: a starter who may not assign cannot write the claim, refused with nothing planned or claimed; one already holding the claim starts', async () => {
  const noAssign = await enrol(s.db.app, s.business, 'wf7-no-assign');
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (const action of ['read', 'write'] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await grantTo(tx, noAssign, action);
    }
  });
  const ticket = await researchTicket('wf7 claim no assign');
  const held = await researchTicket('wf7 claim no assign, held');
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (const id of [ticket, held]) {
      // oxlint-disable-next-line no-await-in-loop
      await grantTo(tx, noAssign, 'write', { kind: 'record', id }, false, 'run');
    }
  });
  expect(await start(noAssign, ticket)).toMatchObject({
    code: 'SCOPE_NOT_GRANTED',
    names: ['task:assign'],
  });
  expect(await facts(ticket)).toStrictEqual({ assignee: null, runs: 0 });
  // Assigned by someone who may (set here as the admin role would), so the
  // start writes no claim and asks no assign.
  await s.db.admin.execute(
    `update public.records set data = data || jsonb_build_object('assignee', $3::uuid)
      where business_id = $1 and id = $2`,
    [s.business, held, noAssign.personId],
  );
  appliedDetail(await start(noAssign, held), 'task.propose');
  expect(await facts(held)).toStrictEqual({ assignee: noAssign.personId, runs: 1 });
}, 60_000);
