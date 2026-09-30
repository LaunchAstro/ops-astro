// SPDX-License-Identifier: AGPL-3.0-only
//
// C54 isolation and `C54 agent refused`: the Agent pane's money acts on an
// unknown effect (`budget.record_outcome`, `budget.write_off`) and the task's
// top-up (`budget.top_up`), through the real API over a fresh Postgres. Task
// one's attempt is held unknown. The crossings, statuses checked, with no body
// carrying task one's ids, refusals included, and task one's hold unmoved:
// - another business: bravo's own budget holder names task one's task and
//   attempt in bravo and is answered exactly as for made-up ones;
// - another client in the same business: an external client sharing task two
//   and granted `billing:decide` on it reaches nothing on task one's (nor on
//   its own: a client's billing grant is never used), and a person granted
//   `billing:decide` on task two only reaches task two's and not task one's;
// - another person under a live delegation: the agent working task three is
//   refused DELEGATION_EXCLUDES_OPERATION on task one's, and on its own.
// The positive control last: alpha's own holder records task one's outcome.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import { createWorld, serverUrl, type Answer, type World } from '../acceptance/world.ts';
import {
  agentOnWork,
  asAgent,
  asPerson,
  billingHolder,
  externalClient,
  holdOf,
  signed,
  unknownWork,
  type Signed,
  type UnknownWork,
} from './c54-fixture.ts';

const REASON = 'The provider never answered; its statement shows no charge.';

/** The three money acts, each naming `work`'s task and attempt. */
const acts = (work: UnknownWork): readonly [CommandName, Record<string, unknown>][] => [
  [
    'budget.record_outcome',
    { recordId: work.taskId, attemptId: work.attemptId, outcome: 'happened' },
  ],
  [
    'budget.write_off',
    { recordId: work.taskId, attemptId: work.attemptId, amountMinor: 0, reason: REASON },
  ],
  ['budget.top_up', { recordId: work.taskId, amountMinor: 100, fromMaximumMinor: 3_000 }],
];

const outcomeOf = (work: UnknownWork): Record<string, unknown> => ({
  recordId: work.taskId,
  attemptId: work.attemptId,
  outcome: 'happened',
});

// eslint-disable-next-line max-lines-per-function -- one world of two businesses, every crossing on it
describe.skipIf(serverUrl === undefined)('C54 isolation', { timeout: 60_000 }, () => {
  let world: World;
  let ada: Signed;
  let one: UnknownWork;
  let two: UnknownWork;
  let bravoHolder: Signed;
  let client: Signed;
  let taskScoped: Signed;
  let agent: { readonly taskId: string; readonly credential: string };
  let foreign: readonly string[] = [];
  let before: Record<string, unknown> | undefined;

  const carriesNothing = (answer: Answer): void => {
    for (const value of foreign) expect(answer.text).not.toContain(value);
  };

  beforeAll(async () => {
    world = await createWorld('c54_isolation');
    ada = signed(world.ada);
    one = await unknownWork(world, ada);
    two = await unknownWork(world, ada);
    const ids = await world.db.admin.execute<{ readonly id: string }>(
      `select res.id from public.attempts att
         join public.reservations res on res.id = att.reservation_id where att.id = $1
       union all select env.id from public.task_envelopes env where env.task_id = $2`,
      [one.attemptId, one.taskId],
    );
    foreign = [one.taskId, one.attemptId, ...ids.map((row) => row.id)];
    bravoHolder = await billingHolder(world, world.bravo, 'bravo', 'bravo-holder');
    client = await externalClient(world, ada, two.taskId);
    taskScoped = await billingHolder(world, world.alpha, 'alpha', 'task-two-holder', two.taskId);
    agent = await agentOnWork(world, ada);
    before = await holdOf(world, one.attemptId);
  }, 240_000);

  afterAll(async () => await world?.close());

  it('C54 isolation: another business: task one’s ids in bravo are answered as made-up ones', async () => {
    const madeUp = { taskId: randomUUID(), attemptId: randomUUID() };
    const fakes = acts(madeUp);
    for (const [index, [name, body]] of acts(one).entries()) {
      const fake = fakes[index]?.[1] ?? {};
      // Sequential: one caller's answers, compared pairwise.
      // eslint-disable-next-line no-await-in-loop
      const across = await asPerson(world, bravoHolder, name, body);
      // eslint-disable-next-line no-await-in-loop
      const made = await asPerson(world, bravoHolder, name, fake);
      expect([name, across.status, across.code]).toStrictEqual([name, 404, 'NOT_FOUND']);
      expect([across.status, across.code]).toStrictEqual([made.status, made.code]);
      carriesNothing(across);
    }
    // Bravo's holder on alpha's own prefix is no member there.
    for (const [name, body] of acts(one)) {
      // eslint-disable-next-line no-await-in-loop
      const onAlpha = await asPerson(world, { ...bravoHolder, businessKey: 'alpha' }, name, body);
      expect(onAlpha.code).not.toBe('ok');
      carriesNothing(onAlpha);
    }
    expect(await holdOf(world, one.attemptId)).toStrictEqual(before);
  });

  it('C54 isolation: another client in the same business reaches nothing of task one’s, nor its own', async () => {
    for (const work of [one, two]) {
      for (const [name, body] of acts(work)) {
        // eslint-disable-next-line no-await-in-loop
        const refused = await asPerson(world, client, name, body);
        // An external client's billing grant is never used (T2e, T3c: R4).
        expect([name, refused.status, refused.code]).toStrictEqual([
          name,
          403,
          'SCOPE_NOT_GRANTED',
        ]);
        carriesNothing(refused);
      }
    }
    // Task two's attempt named under task two with task one's attempt: not found, nothing named.
    const crossed = await asPerson(world, taskScoped, 'budget.record_outcome', {
      recordId: two.taskId,
      attemptId: one.attemptId,
      outcome: 'happened',
    });
    expect([crossed.status, crossed.code]).toStrictEqual([404, 'NOT_FOUND']);
    carriesNothing(crossed);
    for (const [name, body] of acts(one)) {
      // eslint-disable-next-line no-await-in-loop
      const refused = await asPerson(world, taskScoped, name, body);
      expect([name, refused.status, refused.code]).toStrictEqual([name, 403, 'SCOPE_NOT_GRANTED']);
      carriesNothing(refused);
    }
    expect(await holdOf(world, one.attemptId)).toStrictEqual(before);
    // The grant on task two is live: its holder records task two's outcome.
    const own = await asPerson(world, taskScoped, 'budget.record_outcome', outcomeOf(two));
    expect([own.status, own.code]).toStrictEqual([200, 'ok']);
    carriesNothing(own);
    expect(await holdOf(world, one.attemptId)).toStrictEqual(before);
  });

  it('C54 agent refused: the agent under a live delegation reaches no money act, on task one’s or its own', async () => {
    const own = { taskId: agent.taskId, attemptId: randomUUID() };
    for (const work of [one, own]) {
      for (const [name, body] of acts(work)) {
        // eslint-disable-next-line no-await-in-loop
        const refused = await asAgent(world, name, body, agent.credential);
        expect([name, refused.code]).toStrictEqual([name, 'DELEGATION_EXCLUDES_OPERATION']);
        expect(refused.status).toBe(403);
        expect(refused.text).not.toContain(agent.credential);
        carriesNothing(refused);
      }
    }
    // The delegation is live: the same credential still reads its own task.
    const read = await asAgent(world, 'task.read', { recordId: agent.taskId }, agent.credential);
    expect(read.code).toBe('ok');
    expect(await holdOf(world, one.attemptId)).toStrictEqual(before);
  });

  it('C54 isolation: the positive control: alpha’s own holder records task one’s outcome', async () => {
    const own = await asPerson(world, ada, 'budget.record_outcome', outcomeOf(one));
    expect([own.status, own.code]).toStrictEqual([200, 'ok']);
    expect(await holdOf(world, one.attemptId)).not.toStrictEqual(before);
  });
});
