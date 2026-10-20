// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R1 (F2), every settlement and `run.end` stop has a writer. Each stop
// records the attempt's one outcome, with its exact typed code, in the
// transaction that stops the work, and retires the lease and delegation there:
// an accepted answer with no usage is `unknown_provider_outcome /
// LIABILITY_UNKNOWN` with the maximum held; a settled answer whose reply was
// lost, ended `ANSWER_LOST`, is `unknown_provider_outcome / ANSWER_LOST` with
// the observed cost kept; a release for the declared `LOCAL_PLAN_LIMIT` is
// `waiting_plan_allowance`; one for another declared nothing-happened code
// (the replay 429) is `cancelled / PROVIDER_NOTHING_HAPPENED`; an undeclared
// release reason is never a refusal but `LIABILITY_UNKNOWN`, the maximum held;
// `run.end DEFINITION_MISMATCH` (on a real pinned mismatch) and
// `TRACING_NOT_ALLOWED` before call 1, and a door refusal of `task.read`
// ended with its door code, are `cancelled` with that code. Then the worker
// restarts and the clock moves on: one row each, nothing sent again, no
// handback. Clean twins complete and record no stop.
//
// Two seams are narrower than the real thing, since this tree has no script
// for them: the plan limit is the replay operation declared with
// `LOCAL_PLAN_LIMIT` among its nothing-happened codes (`PLAN_LIMITED`); the
// undeclared reason is custody answering a refusal code nothing declares.

import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { expect, it as vitestIt } from 'vitest';
import { REPLAY_COMPOSE } from '../../packages/core-connectors/src/index.ts';
import type { Custody } from '../../packages/core-custody/src/index.ts';
import { setDigest, INSTRUCTION_ROOT_VARIABLE } from '../../packages/core-runtime/src/index.ts';
import {
  createTask,
  handbackBody,
  liveWork,
  rows,
  type Work,
} from '../runtime/schedules-harness.ts';
import {
  asWorker,
  authorityOf,
  brokerOver,
  callsOf,
  door,
  modelCall,
  modelCallBody,
  named,
  noDatabase,
  outcomesOf,
  PLAN_LIMITED,
  restartAndAdvance,
  runEnd,
  s,
  shapeOf,
  useStopWorld,
  world,
} from './run-stop-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useStopWorld('sol1623writers');

/** The codes the agent door refuses with while a delegation is live (R1's door row). */
const DOOR_CODES = [
  'SCOPE_NOT_GRANTED',
  'GATE_SHUT',
  'DELEGATION_EXCLUDES_OPERATION',
  'OPERATION_ID_REUSED',
];

/** Custody whose provider accepted the call and answered, but with no usage in the answer. */
const usageMissing = (base: Custody = world.custody): Custody => ({
  ...base,
  dispatch: async (...args: Parameters<Custody['dispatch']>) => {
    const outcome = await base.dispatch(...args);
    if (outcome.kind !== 'answered' || !outcome.outbound.ok) return outcome;
    const { usage: _usage, ...rest } = JSON.parse(outcome.outbound.body) as Record<string, unknown>;
    return { ...outcome, outbound: { ...outcome.outbound, body: JSON.stringify(rest) } };
  },
});

/** Custody refusing the send with `code`, nothing sent: a release reason no table declares. */
const refusingWith = (code: string, base: Custody = world.custody): Custody => ({
  ...base,
  dispatch: async () => await Promise.resolve({ kind: 'refused', started: false, code }),
});

const fresh = async (what: string): Promise<Work> =>
  await liveWork(s, `sol1623 ${what} ${randomUUID()}`, 2_000);

const runState = async (work: Work): Promise<string> => (await authorityOf(work)).run;

/**
 * The stop recorded `expected` once and retired the work; then a worker
 * restart, the clock moving on, a fresh call and a handback on the old
 * credential change nothing: one row, nothing sent again, no handback.
 */
async function expectEndedOnce(work: Work, expected: ReturnType<typeof named>): Promise<void> {
  expect(shapeOf(await outcomesOf(work)), 'the stop records its one outcome').toEqual([expected]);
  expect(await authorityOf(work), 'the stop retires the work').toMatchObject({
    lease: 'released',
    cause: 'work_retired',
  });
  const recorded = await outcomesOf(work);
  const calls = await callsOf(work);
  const sent = world.provider.seen.length;

  await restartAndAdvance(work);
  world.provider.mode('answer');
  const retried = await modelCall(work);
  expect(retried.status, 'the old credential calls nothing').not.toBe(200);
  const handedBack = await asWorker(door(), work, 'task/handback', handbackBody(work.picked));
  expect(handedBack.status, 'the old credential hands nothing back').not.toBe(200);
  await restartAndAdvance(work);

  expect(await outcomesOf(work), 'still one row, unchanged').toEqual(recorded);
  expect(world.provider.seen.length, 'no call is asked again').toBe(sent);
  expect(await callsOf(work), 'the ledger is unchanged').toEqual(calls);
  expect(await runState(work)).not.toBe('handed_back');
}

it('an accepted call whose answer has no usage records unknown with the maximum held', async () => {
  const work = await fresh('usage missing');
  world.provider.mode('answer');
  const answer = await modelCall(work, door(s.db.app, brokerOver(usageMissing())));
  expect(answer.body['detail'], 'setup: the provider accepted and the call is held').toMatchObject({
    state: 'liability_unknown',
  });

  await expectEndedOnce(work, named('unknown_provider_outcome', 'LIABILITY_UNKNOWN'));
  expect(await callsOf(work)).toMatchObject([{ state: 'liability_unknown', reserved: '500' }]);
});

it('a settled answer whose reply was lost ends ANSWER_LOST with its observed cost kept', async () => {
  const work = await fresh('answer lost');
  world.provider.mode('answer');
  // The call settles; its reply never reaches the worker, which ends the run.
  await modelCall(work);
  expect(await callsOf(work), 'setup: the call settled').toMatchObject([
    { state: 'settled', actual: '100' },
  ]);

  const ended = await runEnd(work, 'ANSWER_LOST');
  await expectEndedOnce(work, named('unknown_provider_outcome', 'ANSWER_LOST'));
  expect(ended.body['code']).toBe('RUN_ENDED');
  expect(await callsOf(work), 'the observed cost is kept').toMatchObject([
    { state: 'settled', actual: '100', observed: '100' },
  ]);
});

it('a release for the declared LOCAL_PLAN_LIMIT waits for the plan allowance', async () => {
  const work = await fresh('plan limit');
  world.provider.mode('nothing_happened');
  const answer = await modelCall(work, door(), modelCallBody(work, PLAN_LIMITED.key));
  expect(answer.body['detail'], 'setup: released for the plan limit').toMatchObject({
    state: 'released',
    outcome: 'CALL_RELEASED',
  });

  await expectEndedOnce(work, named('waiting_plan_allowance', 'LOCAL_PLAN_LIMIT'));
  expect(await callsOf(work)).toMatchObject([{ state: 'released' }]);
});

it('a release for a declared nothing-happened code (replay http_429) is cancelled PROVIDER_NOTHING_HAPPENED', async () => {
  const work = await fresh('rate limited');
  world.provider.mode('rate_limited');
  const answer = await modelCall(work);
  expect(answer.body['detail'], 'setup: released on the 429').toMatchObject({
    state: 'released',
    outcome: 'CALL_RELEASED',
  });

  await expectEndedOnce(work, named('cancelled', 'PROVIDER_NOTHING_HAPPENED'));
  expect(await callsOf(work)).toMatchObject([{ state: 'released' }]);
});

it('an undeclared release reason is held unknown with the maximum, never a refusal', async () => {
  const work = await fresh('undeclared reason');
  const undeclared = `NOT_A_DECLARED_REASON_${randomUUID().slice(0, 8).toUpperCase()}`;
  await modelCall(work, door(s.db.app, brokerOver(refusingWith(undeclared))));

  await expectEndedOnce(work, named('unknown_provider_outcome', 'LIABILITY_UNKNOWN'));
  expect(await callsOf(work), 'the maximum stays held').toMatchObject([
    { state: 'liability_unknown', reserved: '500' },
  ]);
});

/**
 * The run pinned to an approved instruction file whose bytes then changed, so
 * the pinned read under the lease finds its own typed mismatch. The process's
 * instruction root is `folder`.
 */
async function pinThenChange(work: Work, folder: string): Promise<void> {
  process.env[INSTRUCTION_ROOT_VARIABLE] = folder;
  const path = 'AGENTS.md';
  const approved = Buffer.from('# Approved instructions\n');
  writeFileSync(join(folder, path), approved);
  const identity = {
    path,
    digest: createHash('sha256').update(approved).digest('hex'),
    size: approved.byteLength,
  };
  const [lease] = await rows<{ run_id: string }>(
    s,
    'select run_id::text as run_id from public.leases where id = $1',
    [work.picked['leaseId']],
  );
  await s.db.admin.execute(
    `insert into public.run_definition_pins
       (business_id, run_id, ref_kind, path, content_digest, content_size, read_at, manifest,
        manifest_digest, pinned_by_actor_id)
     values ($1, $2, 'bootstrap_file', $3, $4, $5, now(), $6::text::jsonb, $7, $8)`,
    [
      s.business,
      lease?.run_id,
      path,
      identity.digest,
      identity.size,
      JSON.stringify([identity]),
      setDigest([identity]).digest,
      s.decider.actorId,
    ],
  );
  writeFileSync(join(folder, path), '# Changed after approval\n');
}

it('run.end DEFINITION_MISMATCH before call 1 is cancelled with that code', async () => {
  const work = await fresh('definition mismatch');
  const folder = mkdtempSync(join(tmpdir(), 'sol1623-pin-'));
  const before = process.env[INSTRUCTION_ROOT_VARIABLE];
  try {
    await pinThenChange(work, folder);
    const ended = await runEnd(work, 'DEFINITION_MISMATCH');
    await expectEndedOnce(work, named('cancelled', 'DEFINITION_MISMATCH'));
    expect(ended.body['code']).toBe('RUN_ENDED');
    expect(await callsOf(work)).toEqual([]);
  } finally {
    if (before === undefined) delete process.env[INSTRUCTION_ROOT_VARIABLE];
    else process.env[INSTRUCTION_ROOT_VARIABLE] = before;
    rmSync(folder, { recursive: true, force: true });
  }
});

it('run.end TRACING_NOT_ALLOWED before call 1 is cancelled with that code', async () => {
  const work = await fresh('tracing refused');
  const ended = await runEnd(work, 'TRACING_NOT_ALLOWED');
  await expectEndedOnce(work, named('cancelled', 'TRACING_NOT_ALLOWED'));
  expect(ended.body['code']).toBe('RUN_ENDED');
  expect(await callsOf(work)).toEqual([]);
});

it('a door refusal of task.read, ended with its door code, is cancelled with that code', async () => {
  const work = await fresh('door refusal');
  // The worker reads its own task, then sends another read under that same
  // operation id: the door refuses the reuse while the delegation is live.
  const operationId = randomUUID();
  const own = await asWorker(door(), work, 'task/read', { operationId, recordId: work.taskId });
  expect(own.status, 'setup: the worker reads its own task').toBe(200);
  const elsewhere = await createTask(s, `sol1623 another task ${randomUUID()}`);
  const read = await asWorker(door(), work, 'task/read', { operationId, recordId: elsewhere });
  const doorCode = String(read.body['code']);
  expect(DOOR_CODES, `setup: the door refused the read (${doorCode})`).toContain(doorCode);
  expect(await authorityOf(work), 'setup: the delegation is still live').toMatchObject({
    lease: 'live',
    cause: null,
  });

  const ended = await runEnd(work, doorCode);
  await expectEndedOnce(work, named('cancelled', doorCode));
  expect(ended.body['code']).toBe('RUN_ENDED');
});

/** A clean run: it reads its own task, calls, settles and hands back, and no stop records. */
async function expectCleanTwin(app: Hono, operation: string): Promise<void> {
  const work = await fresh(`clean twin ${operation}`);
  world.provider.mode('answer');
  const read = await asWorker(app, work, 'task/read', {
    operationId: randomUUID(),
    recordId: work.taskId,
  });
  expect(read.status).toBe(200);
  const answer = await modelCall(work, app, modelCallBody(work, operation));
  expect(answer.body['detail']).toMatchObject({ state: 'settled', actualMinor: 100 });
  const handedBack = await asWorker(app, work, 'task/handback', handbackBody(work.picked));
  expect(handedBack.status).toBe(200);
  const stops = (await outcomesOf(work)).filter((row) => row.outcome !== 'success');
  expect(stops, 'a clean run records no stop').toEqual([]);
  expect(await runState(work)).toBe('handed_back');
}

it('control: clean twins complete and record no stop', async () => {
  await expectCleanTwin(door(), REPLAY_COMPOSE.key);
  await expectCleanTwin(door(), PLAN_LIMITED.key);
});
