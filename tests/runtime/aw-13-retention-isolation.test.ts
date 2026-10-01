// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13 retention isolation: one business's pass deletes and records only its
// own runs; a pass names no task, title or client, so a client of the same
// business learns nothing of another client's work from it; and another
// person's agent, under its own live delegation, keeps its work and its trace
// through a pass and reaches no retention operation.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import {
  executeAgentCommand,
  executeRead,
  isCommandRefusal,
} from '../../packages/core-commands/src/index.ts';
import { derivedId, expireOnce, TRACE_WINDOW_DAYS } from '../../packages/core-runtime/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { cq8World } from './cq-8-world.ts';
import { asAgent, codeOf, liveWork, type Schedules } from './schedules-harness.ts';
import { drain, noDatabase, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';
import { age, batchesOf, clearSeen, deletedIds } from './aw-13-retention-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useAw13World('aw13reti');

const traceOf = (s: Schedules, runId: string): string =>
  derivedId(TRACE_KEY, ['trace', s.business, runId], 32);

async function pass(s: Schedules): ReturnType<typeof expireOnce> {
  return await expireOnce(t.alpha.db.app, s.business, TRACE_KEY, t.target.expiry);
}

/** Every body and path the target saw, as one text. */
const sent = (): string => JSON.stringify([t.target.received, t.target.paths]);

it('AW-13 retention isolation: another business', async () => {
  const canary = `aw13-ret-alpha-${randomUUID()}`;
  const alpha = await liveWork(t.alpha, canary, 1_000);
  const bravo = await liveWork(t.bravo, `aw13-ret-bravo-${randomUUID()}`, 1_000);
  await drain(t.alpha);
  await drain(t.bravo);
  const [alphaRun, bravoRun] = [String(alpha.picked['runId']), String(bravo.picked['runId'])];
  await age(alphaRun, TRACE_WINDOW_DAYS + 1);
  await age(bravoRun, TRACE_WINDOW_DAYS + 1);
  const bravoBefore = (await batchesOf(t.bravo)).length;
  clearSeen();

  const passes = await pass(t.alpha);
  expect(passes.at(-1)).toMatchObject({ code: null });
  // Alpha's pass deletes alpha's run alone, and records nothing in bravo.
  expect(deletedIds()).toContain(traceOf(t.alpha, alphaRun));
  expect(deletedIds()).not.toContain(traceOf(t.bravo, bravoRun));
  // Bravo's run under alpha's key and alpha's business would be a different
  // id: nothing of bravo's run reaches alpha's pass by any spelling.
  expect(deletedIds()).not.toContain(traceOf(t.alpha, bravoRun));
  expect((await batchesOf(t.bravo)).length).toBe(bravoBefore);
  const alphaBatches = await batchesOf(t.alpha);
  expect(alphaBatches.some((one) => one.expired_run_ids.includes(bravoRun))).toBe(false);
  expect(t.target.stored.has(traceOf(t.bravo, bravoRun))).toBe(true);
  for (const text of [sent(), JSON.stringify(passes), JSON.stringify(alphaBatches)]) {
    expect(text).not.toContain(canary);
    expect(text).not.toContain(bravoRun);
    expect(text).not.toContain(bravo.taskId);
    expect(text).not.toContain(t.bravo.business);
  }
  // A tenant transaction of bravo sees none of alpha's recorded passes.
  const foreign = await t.alpha.db.app.withBusiness(
    t.bravo.business,
    async (tx) =>
      await tx.query<{ n: string }>(
        'select count(*)::text as n from public.trace_expiry_batches where business_id <> $1',
        [t.bravo.business],
      ),
  );
  expect(foreign[0]?.n).toBe('0');
  // Control: bravo's own pass deletes bravo's run.
  await pass(t.bravo);
  expect(t.target.stored.has(traceOf(t.bravo, bravoRun))).toBe(false);
});

it('AW-13 retention isolation: another client in the same business', async () => {
  const canary = `aw13-ret-client-two-${randomUUID()}`;
  const one = await liveWork(t.alpha, `aw13-ret-client-one-${randomUUID()}`, 1_000);
  const two = await liveWork(t.alpha, canary, 1_000);
  await drain(t.alpha);
  await t.alpha.db.app.withBusiness(t.alpha.business, async (tx) => {
    await grantTo(tx, t.alpha.decider, 'share');
  });
  const clientTwo = await cq8World(t.alpha).client(
    t.alpha.business,
    t.alpha.decider,
    'aw13-ret-two',
    two.taskId,
  );
  await age(String(one.picked['runId']), TRACE_WINDOW_DAYS + 1);
  clearSeen();
  await pass(t.alpha);
  expect(deletedIds()).toContain(traceOf(t.alpha, String(one.picked['runId'])));
  // What left names no task, no title and no client of either.
  for (const text of [sent()]) {
    expect(text).not.toContain(canary);
    expect(text).not.toContain(one.taskId);
    expect(text).not.toContain(two.taskId);
  }
  // Client two's own task inside the window keeps its trace; client two reads
  // its own task and never client one's.
  expect(t.target.stored.has(traceOf(t.alpha, String(two.picked['runId'])))).toBe(true);
  const read = async (recordId: string) =>
    await executeRead(t.alpha.db.app, t.alpha.business, clientTwo.presented, {
      read: 'task.read',
      recordId,
    } as never);
  expect(await read(two.taskId)).toHaveProperty('sharedTask');
  const crossed = await read(one.taskId);
  expect(crossed).toMatchObject({ code: 'NOT_FOUND' });
  expect(JSON.stringify(crossed)).not.toContain(String(one.picked['runId']));
});

it('AW-13 retention isolation: another person, an agent under a live delegation', async () => {
  const canary = `aw13-ret-person-${randomUUID()}`;
  const live = await liveWork(t.alpha, canary, 1_000);
  const credential = String(live.picked['credential']);
  const old = await liveWork(t.alpha, `aw13-ret-old-${randomUUID()}`, 1_000);
  await drain(t.alpha);
  await age(String(old.picked['runId']), TRACE_WINDOW_DAYS + 1);
  clearSeen();
  await pass(t.alpha);
  // The other work's run went; the live agent's work and trace did not, and
  // nothing of its delegation left.
  expect(deletedIds()).toContain(traceOf(t.alpha, String(old.picked['runId'])));
  expect(deletedIds()).not.toContain(traceOf(t.alpha, String(live.picked['runId'])));
  expect(t.target.stored.has(traceOf(t.alpha, String(live.picked['runId'])))).toBe(true);
  expect(sent()).not.toContain(credential);
  expect(sent()).not.toContain(String(live.picked['delegationId']));
  expect(sent()).not.toContain(canary);
  expect(
    codeOf(
      await asAgent(
        t.alpha,
        { command: 'task.read', operationId: randomUUID(), recordId: live.taskId },
        credential,
      ),
    ),
  ).toBe('applied');
  // The agent reaches no retention operation by any name.
  for (const command of ['trace.expire', 'trace.retention', 'trace.delete']) {
    // oxlint-disable-next-line no-await-in-loop
    const answer = await executeAgentCommand(
      t.alpha.db.app,
      t.alpha.business,
      t.alpha.agent,
      credential,
      { command, operationId: randomUUID() } as never,
    );
    expect(isCommandRefusal(answer), command).toBe(true);
    expect(codeOf(answer as never), command).toBe('DELEGATION_EXCLUDES_OPERATION');
    expect(JSON.stringify(answer)).not.toContain(canary);
  }
});
