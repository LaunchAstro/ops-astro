// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7 (#640) "`ticket resolved (answer, gist)` · `task:write`, yes inside its
// delegation". The run's agent resolves the research ticket it picked up,
// under the delegation pickup minted: its own ticket only, only while its
// person still holds `task:write` there, only a research ticket (a task or
// build ticket closes through its own run), and never a grilling or prototype
// ticket, which needs `task:decide`, a key no agent holds. On the real agent
// entry against Postgres.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
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
  racer,
  revisionOf,
  seedSchedules,
  type Schedules,
} from '../runtime/schedules-harness.ts';

let s: Schedules;

/** A task picked up by the agent and then typed, and the credential its pickup minted. */
const pickedTicket = async (
  on: Schedules,
  title: string,
  taskType: string,
): Promise<{ ticket: string; credential: string }> => {
  const ticket = await createTask(on, title);
  const proposal = await propose(on, ticket, { purpose: freshPurpose() });
  const picked = await pickup(on, (await approve(on, proposal))['reservationId']);
  // A new task is of type task already.
  if (taskType === 'task') return { ticket, credential: String(picked['credential']) };
  appliedDetail(
    await asPerson(on, {
      command: 'task.set_type',
      operationId: randomUUID(),
      recordId: ticket,
      expectedRevision: await revisionOf(on, ticket),
      taskType,
    }),
    'task.set_type',
  );
  return { ticket, credential: String(picked['credential']) };
};

const resolveBody = async (on: Schedules, ticket: string) => ({
  command: 'task.resolve',
  operationId: randomUUID(),
  recordId: ticket,
  expectedRevision: await revisionOf(on, ticket),
  answer: 'The cited answer [1].',
  gist: 'Answered, with one source.',
});

const ticketData = async (on: Schedules, ticket: string) =>
  (
    await on.db.admin.execute<{ answer: string | null; revision: number }>(
      `select data->>'answer' as answer, revision::int as revision
         from public.records where business_id = $1 and id = $2`,
      [on.business, ticket],
    )
  )[0];

/** Every case needs the database; without one the file is skipped. */
const noDatabase = databaseUrlFromEnvironment() === undefined;
const it = noDatabase ? vitestIt.skip : vitestIt;

beforeAll(async () => {
  if (!noDatabase) s = await openSchedules('wf7resolve', 1_000_000);
}, 180_000);
afterAll(async () => await s?.db.drop());

it('WF-7 ticket resolved inside its delegation: the agent resolves its own research ticket, by its own actor, in the chain', async () => {
  const { ticket, credential } = await pickedTicket(s, 'wf7 resolve own', 'research');
  const detail = appliedDetail(
    await asAgent(s, await resolveBody(s, ticket), credential),
    'task.resolve',
  );
  expect(detail['gist']).toBe('Answered, with one source.');
  expect((await ticketData(s, ticket))?.answer).toBe('The cited answer [1].');
  const events = await s.db.admin.execute<{ actor_id: string }>(
    `select actor_id from public.audit_events
      where business_id = $1 and command = 'task.resolve' and subject_record_id = $2
        and outcome = 'applied'`,
    [s.business, ticket],
  );
  expect(events.map((event) => event.actor_id)).toStrictEqual([s.agentActorId]);
  const chain = await s.db.app.withBusiness(s.business, (tx) => verifyAuditChain(tx));
  expect(chain.intact).toBe(true);
}, 120_000);

it('WF-7 ticket resolved inside its delegation: two resolves at once on one revision, under the ticket lock, one applies', async () => {
  const { ticket, credential } = await pickedTicket(s, 'wf7 resolve race', 'research');
  const [one, two] = [racer(s), racer(s)];
  try {
    const body = await resolveBody(s, ticket);
    const answers = await Promise.all([
      asAgent(s, body, credential, one),
      asAgent(s, { ...body, operationId: randomUUID() }, credential, two),
    ]);
    expect(answers.map((answer) => codeOf(answer)).toSorted()).toStrictEqual([
      'VERSION_STALE',
      'applied',
    ]);
  } finally {
    await Promise.all([one.close(), two.close()]);
  }
}, 120_000);

it('WF-7 ticket resolved inside its delegation: another ticket is out of purpose, and nothing is written', async () => {
  const { credential } = await pickedTicket(s, 'wf7 resolve picked', 'research');
  const sibling = await createTask(s, 'wf7 resolve sibling');
  const before = await ticketData(s, sibling);
  const answer = await asAgent(s, await resolveBody(s, sibling), credential);
  expect(codeOf(answer)).toBe('DELEGATION_OUT_OF_PURPOSE');
  expect(await ticketData(s, sibling)).toStrictEqual(before);
}, 120_000);

it('WF-7 ticket resolved inside its delegation: a grilling ticket needs decide, which no agent holds', async () => {
  const { ticket, credential } = await pickedTicket(s, 'wf7 resolve grilling', 'grilling');
  const before = await ticketData(s, ticket);
  const answer = await asAgent(s, await resolveBody(s, ticket), credential);
  expect(codeOf(answer)).toBe('DELEGATION_EXCLUDES_DECISION');
  expect(await ticketData(s, ticket)).toStrictEqual(before);
}, 120_000);

it('WF-7 ticket resolved inside its delegation: the run resolves a research ticket only, never a task or build ticket', async () => {
  for (const taskType of ['task', 'build']) {
    // eslint-disable-next-line no-await-in-loop -- one ticket at a time, each checked
    const { ticket, credential } = await pickedTicket(s, `wf7 resolve ${taskType}`, taskType);
    // eslint-disable-next-line no-await-in-loop
    const before = await ticketData(s, ticket);
    // eslint-disable-next-line no-await-in-loop
    const answer = await asAgent(s, await resolveBody(s, ticket), credential);
    expect(codeOf(answer), taskType).toBe('DELEGATION_OUT_OF_PURPOSE');
    // eslint-disable-next-line no-await-in-loop
    expect(await ticketData(s, ticket)).toStrictEqual(before);
  }
}, 180_000);

it('WF-7 refusal task:write: an agent whose person no longer holds task:write resolves nothing', async () => {
  // A business of its own, so revoking its person's write leaves the others'.
  const narrowed = await seedSchedules(s.db, 'wf7resolve-narrowed', 1_000_000);
  const { ticket, credential } = await pickedTicket(narrowed, 'wf7 resolve narrowed', 'research');
  await narrowed.db.admin.execute(
    `update public.grants set revoked_at = now()
      where business_id = $1 and subject_kind = 'person' and subject_id = $2
        and collection = 'task' and action = 'write'`,
    [narrowed.business, narrowed.decider.personId],
  );
  const before = await ticketData(narrowed, ticket);
  const answer = await asAgent(narrowed, await resolveBody(narrowed, ticket), credential);
  expect(codeOf(answer)).toBe('DELEGATION_NARROWED');
  expect(await ticketData(narrowed, ticket)).toStrictEqual(before);
}, 120_000);

it('WF-7 ticket resolved inside its delegation: another business’s ticket is not reached with this credential', async () => {
  const other = await seedSchedules(s.db, 'wf7resolve-other', 1_000_000);
  const { credential } = await pickedTicket(s, 'wf7 resolve home', 'research');
  const { ticket: foreign } = await pickedTicket(other, 'wf7 resolve foreign', 'research');
  const before = await ticketData(other, foreign);
  const answer = await asAgent(
    { ...s, business: other.business },
    await resolveBody(other, foreign),
    credential,
  );
  expect(codeOf(answer)).toBe('AUTH_NO_AGENT_IDENTITY');
  expect(answer).not.toHaveProperty('recordId');
  expect(await ticketData(other, foreign)).toStrictEqual(before);
}, 120_000);
