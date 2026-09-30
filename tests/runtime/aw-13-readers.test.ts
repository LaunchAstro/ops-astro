// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13 readers: reading a run's trace (`trace.read`) takes `operations:read`,
// the key the install gives the owner and administrators and never a member
// or an agent (C55). The answer is the spans the export sends, less the ids
// only the exporter's key derives: timings, counts and codes, never a
// sentence. Inside the business, only a task the caller reads.
//
// Crossings, each with its control: another business; another client in the
// same business (a reader whose task grant covers client one's task, and
// client two's own external person); another person, an agent under a live
// delegation.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';
import { executeAgentCommand, executeRead } from '../../packages/core-commands/src/index.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { cq8World } from './cq-8-world.ts';
import { codeOf, liveWork, rows, type Schedules } from './schedules-harness.ts';
import { drain, noDatabase, t, useAw13World } from './aw-13-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useAw13World('aw13read');

const SPAN_KEYS = [
  'durationMs',
  'errorCode',
  'exported',
  'runId',
  'sequence',
  'stage',
  'startedAtMs',
  'transformVersion',
];

type Answer = Readonly<Record<string, unknown>>;

async function traceRead(s: Schedules, who: VerifiedSubject, recordId: string): Promise<Answer> {
  return (await executeRead(s.db.app, s.business, who, {
    read: 'trace.read',
    recordId,
  } as never)) as Answer;
}

/** A person of the business holding `operations:read`, and `task:read` on the business, or on `taskId` alone. */
async function reader(s: Schedules, name: string, taskId?: string): Promise<Member> {
  const member = await enrol(s.db.app, s.business, name);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, member, 'read', undefined, false, 'operations');
    await grantTo(
      tx,
      member,
      'read',
      taskId === undefined ? undefined : { kind: 'record', id: taskId },
    );
  });
  return member;
}

function spansOf(answer: Answer): readonly Answer[] {
  return ((answer['trace'] ?? {}) as { spans?: Answer[] }).spans ?? [];
}

function namesNothing(answer: Answer, needles: readonly string[]): void {
  const text = JSON.stringify(answer);
  for (const needle of needles) expect(text.includes(needle), needle).toBe(false);
}

it('AW-13 readers: a holder of operations:read reads a run’s trace as timings, counts and codes', async () => {
  const title = `aw13-read-${randomUUID()} https://client-${randomUUID()}.example/page`;
  const work = await liveWork(t.alpha, title, 1_000);
  await drain(t.alpha);
  const owner = await reader(t.alpha, 'aw13-owner');

  const answer = await traceRead(t.alpha, owner.presented, work.taskId);
  expect(answer).toMatchObject({ ok: true, trace: { taskId: work.taskId } });
  const spans = spansOf(answer);
  expect(spans.length).toBeGreaterThan(0);
  for (const span of spans) {
    expect(Object.keys(span).toSorted()).toEqual(SPAN_KEYS);
    expect(span).toMatchObject({
      runId: work.picked['runId'],
      exported: true,
      transformVersion: 1,
    });
  }
  expect(spans.map((span) => span['stage'])).toContain('claimed');
  // Never a sentence: the title, its site and the delegation stay home.
  namesNothing(answer, [title, String(work.picked['credential'])]);
});

it('AW-13 readers: a member holding task grants but not operations:read is refused, never shown an empty trace', async () => {
  const title = `aw13-read-member-${randomUUID()}`;
  const work = await liveWork(t.alpha, title, 1_000);
  await drain(t.alpha);
  // The decider reads, writes and decides the task, and holds no operations key.
  const answer = await traceRead(t.alpha, t.alpha.decider.presented, work.taskId);
  expect(answer).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
  expect(answer).not.toHaveProperty('trace');
  namesNothing(answer, [title, String(work.picked['runId'])]);
});

it('AW-13 readers: no agent reaches trace.read, and its row says so', () => {
  const row = COMMAND_SURFACE.find((command) => (command.name as string) === 'trace.read');
  expect(row).toMatchObject({ kind: 'read', collection: 'operations', action: 'read' });
  expect(row?.agent).toBe('never');
});

it('AW-13 readers isolation: another business, another client in the same business and another person under a live delegation each read nothing', async () => {
  const { alpha, bravo } = t;
  const canary = `aw13-read-iso-${randomUUID()}`;
  const one = await liveWork(alpha, `${canary}-one`, 1_000);
  const two = await liveWork(alpha, `${canary}-two`, 1_000);
  const foreign = await liveWork(bravo, `aw13-read-bravo-${randomUUID()}`, 1_000);
  await drain(alpha);
  await drain(bravo);
  const alphaIds = [one, two].flatMap((w) => [w.taskId, String(w.picked['runId'])]);

  // Another business: bravo's owner, with operations:read in bravo, asks alpha's task.
  const bravoOwner = await reader(bravo, 'aw13-bravo-owner');
  const crossedBusiness = await traceRead(bravo, bravoOwner.presented, one.taskId);
  expect(crossedBusiness).toMatchObject({ code: 'NOT_FOUND' });
  namesNothing(crossedBusiness, [canary, ...alphaIds]);
  // Control: bravo's own task answers.
  expect(
    spansOf(await traceRead(bravo, bravoOwner.presented, foreign.taskId)).length,
  ).toBeGreaterThan(0);

  // Another client in the same business: a reader whose task grant is client
  // one's task alone, and client two's own external person.
  const scoped = await reader(alpha, 'aw13-scoped-owner', one.taskId);
  const crossedClient = await traceRead(alpha, scoped.presented, two.taskId);
  expect(crossedClient).toMatchObject({ code: 'NOT_FOUND' });
  namesNothing(crossedClient, [canary, two.taskId, String(two.picked['runId'])]);
  expect(spansOf(await traceRead(alpha, scoped.presented, one.taskId)).length).toBeGreaterThan(0);
  await alpha.db.app.withBusiness(alpha.business, async (tx) => {
    await grantTo(tx, alpha.decider, 'share');
  });
  const clientTwo = await cq8World(alpha).client(
    alpha.business,
    alpha.decider,
    'aw13-read-two',
    two.taskId,
  );
  for (const taskId of [one.taskId, two.taskId]) {
    // eslint-disable-next-line no-await-in-loop -- one crossing at a time
    const external = await traceRead(alpha, clientTwo.presented, taskId);
    expect(external, taskId).toMatchObject({ code: 'NOT_FOUND' });
    namesNothing(external, [canary, ...alphaIds]);
  }

  // Another person: the agent under its own live delegation reaches no trace.
  const credential = String(one.picked['credential']);
  const live = await rows<{ state: string }>(
    alpha,
    `select case when revoked_at is null and settled_at is null and expires_at > now() then 'live' else 'ended' end as state
       from public.delegations where business_id = $1 and id = $2`,
    [alpha.business, one.picked['delegationId']],
  );
  expect(live[0]?.state).toBe('live');
  const own = await executeAgentCommand(alpha.db.app, alpha.business, alpha.agent, credential, {
    command: 'task.read',
    operationId: randomUUID(),
    recordId: one.taskId,
  } as never);
  expect(codeOf(own as never)).toBe('applied');
  const agentAnswer = (await executeAgentCommand(
    alpha.db.app,
    alpha.business,
    alpha.agent,
    credential,
    {
      command: 'trace.read',
      operationId: randomUUID(),
      recordId: one.taskId,
    } as never,
  )) as unknown as Answer;
  expect(codeOf(agentAnswer as never)).toBe('DELEGATION_EXCLUDES_OPERATION');
  namesNothing(agentAnswer, [canary, String(one.picked['runId'])]);
});
