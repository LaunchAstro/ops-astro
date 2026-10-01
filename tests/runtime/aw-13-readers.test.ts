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
// client one's own external person); another person, an agent under a live
// delegation.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';
import { executeAgentCommand, executeRead } from '../../packages/core-commands/src/index.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { cq8World } from './cq-8-world.ts';
import { codeOf, liveWork, rows, type Schedules, type Work } from './schedules-harness.ts';
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

/** Work in alpha whose title is a canary, exported, and the ids a crossing must not show. */
async function canaryWork(): Promise<{ canary: string; work: Work; ids: string[] }> {
  const canary = `aw13-read-iso-${randomUUID()}`;
  const work = await liveWork(t.alpha, canary, 1_000);
  await drain(t.alpha);
  return { canary, work, ids: [work.taskId, String(work.picked['runId'])] };
}

it('AW-13 readers isolation: another business, its owner holding operations:read, reads nothing of alpha', async () => {
  const { canary, work, ids } = await canaryWork();
  const foreign = await liveWork(t.bravo, `aw13-read-bravo-${randomUUID()}`, 1_000);
  await drain(t.bravo);
  const bravoOwner = await reader(t.bravo, 'aw13-bravo-owner');
  const crossed = await traceRead(t.bravo, bravoOwner.presented, work.taskId);
  expect(crossed).toMatchObject({ code: 'NOT_FOUND' });
  namesNothing(crossed, [canary, ...ids]);
  // Control: bravo's own task answers.
  const own = await traceRead(t.bravo, bravoOwner.presented, foreign.taskId);
  expect(spansOf(own).length).toBeGreaterThan(0);
});

it('AW-13 readers isolation: another client in the same business reads nothing of the first client’s task', async () => {
  const { canary, work: two, ids } = await canaryWork();
  const one = await liveWork(t.alpha, `aw13-read-one-${randomUUID()}`, 1_000);
  await drain(t.alpha);
  // A reader whose task grant is client one's task alone.
  const scoped = await reader(t.alpha, 'aw13-scoped-owner', one.taskId);
  const crossed = await traceRead(t.alpha, scoped.presented, two.taskId);
  expect(crossed).toMatchObject({ code: 'NOT_FOUND' });
  namesNothing(crossed, [canary, ...ids]);
  expect(spansOf(await traceRead(t.alpha, scoped.presented, one.taskId)).length).toBeGreaterThan(0);
  // Client one's own external person, shared on its task, holds no operations key.
  await t.alpha.db.app.withBusiness(t.alpha.business, async (tx) => {
    await grantTo(tx, t.alpha.decider, 'share');
  });
  const world = cq8World(t.alpha);
  const clientOne = await world.client(t.alpha.business, t.alpha.decider, 'aw13-one', one.taskId);
  for (const taskId of [one.taskId, two.taskId]) {
    // eslint-disable-next-line no-await-in-loop -- one crossing at a time
    const external = await traceRead(t.alpha, clientOne.presented, taskId);
    expect(external, taskId).toMatchObject({ code: 'NOT_FOUND' });
    namesNothing(external, [canary, ...ids]);
  }
});

it('AW-13 readers isolation: another person, an agent under a live delegation, reaches no trace', async () => {
  const { canary, work, ids } = await canaryWork();
  const credential = String(work.picked['credential']);
  const live = await rows<{ state: string }>(
    t.alpha,
    `select case when revoked_at is null and settled_at is null and expires_at > now()
                 then 'live' else 'ended' end as state
       from public.delegations where business_id = $1 and id = $2`,
    [t.alpha.business, work.picked['delegationId']],
  );
  expect(live[0]?.state).toBe('live');
  const asAgent = async (command: string): Promise<Answer> =>
    (await executeAgentCommand(t.alpha.db.app, t.alpha.business, t.alpha.agent, credential, {
      command,
      operationId: randomUUID(),
      recordId: work.taskId,
    } as never)) as unknown as Answer;
  // Control: the delegation reads its own task.
  expect(codeOf((await asAgent('task.read')) as never)).toBe('applied');
  const answer = await asAgent('trace.read');
  expect(codeOf(answer as never)).toBe('DELEGATION_EXCLUDES_OPERATION');
  namesNothing(answer, [canary, ids[1] ?? '']);
});
