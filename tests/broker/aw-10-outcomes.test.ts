// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-10, the three recorded outcomes against a broker effect (O7, O8), and
// `AW-10 no timer`. Where the provider cannot say whether the call went out,
// a person holding budget permission records one of three outcomes on the
// task, each a recorded decision with their name on it: nothing happened (the
// call's hold goes back and the work resumes), it happened (the call is
// recorded as the effect, at its maximum, and the work finishes) or it
// happened differently (recorded the same, and the work reopens). Until then
// the unknown liability holds its full maximum: no pass, however late,
// resolves it, and only a person's write-off with an amount and a reason
// closes it otherwise.

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it as vitestIt } from 'vitest';
import { appliedDetail, asPerson, codeOf, rows } from '../runtime/schedules-harness.ts';
import {
  attemptsOf,
  callsOf,
  dropped,
  noDatabase,
  outcome,
  pass,
  s,
  useFaultWorld,
  world,
} from './aw-10-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useFaultWorld('aw10out');

/** A drop the provider cannot answer for: the lookup never gets through. */
async function unanswerable() {
  world.provider.lookupMode('unreachable');
  const run = await dropped('cut');
  await pass();
  expect(await callsOf(s, run.work)).toMatchObject([{ state: 'liability_unknown' }]);
  return run;
}

it("AW-10 three outcomes: nothing happened releases the call, resumes the work and carries the person's name", async () => {
  const { work } = await unanswerable();
  appliedDetail(await outcome(s, work, 'nothing_happened'), 'budget.record_outcome');
  expect(await callsOf(s, work)).toMatchObject([
    { state: 'released', outcome: 'nothing_happened', outcome_person_id: s.decider.personId },
  ]);
  const [first, second] = await attemptsOf(s, work);
  expect(first).toMatchObject({ state: 'abandoned' });
  expect(second).toMatchObject({ state: 'reserved', held: 'held' });
  const [decided] = await rows<{ actor_id: string }>(
    s,
    `select actor_id from public.operations
      where business_id = $1 and command = 'budget.record_outcome' and record_id = $2`,
    [s.business, work.taskId],
  );
  expect(decided?.actor_id).toBe(s.decider.actorId);
});

it("AW-10 three outcomes: it happened records the effect at the call's maximum and finishes the work", async () => {
  const { work } = await unanswerable();
  appliedDetail(await outcome(s, work, 'happened'), 'budget.record_outcome');
  expect(await callsOf(s, work)).toMatchObject([
    { state: 'settled', actual: '500', outcome: 'happened', outcome_person_id: s.decider.personId },
  ]);
  const found = await attemptsOf(s, work);
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({ state: 'settled' });
});

it('AW-10 three outcomes: it happened differently records the effect and reopens the work', async () => {
  const { work } = await unanswerable();
  // Room for the reopened work beside the spent hold, by the person who approved it (T2e).
  appliedDetail(
    await asPerson(s, {
      command: 'budget.top_up',
      operationId: randomUUID(),
      recordId: work.taskId,
      amountMinor: 2_000,
      fromMaximumMinor: 2_000,
    }),
    'budget.top_up',
  );
  appliedDetail(await outcome(s, work, 'happened_differently'), 'budget.record_outcome');
  expect(await callsOf(s, work)).toMatchObject([
    { state: 'settled', actual: '500', outcome: 'happened_differently' },
  ]);
  const [first, second] = await attemptsOf(s, work);
  expect(first).toMatchObject({ state: 'settled' });
  expect(second).toMatchObject({ state: 'reserved' });
});

it('AW-10 no timer: no pass, however late, resolves an unknown call or its liability; only a person does', async () => {
  const { work } = await unanswerable();
  const before = [await callsOf(s, work), await attemptsOf(s, work)];
  // A day on, and the provider still unreachable: the passes change nothing.
  await s.db.admin.execute(
    `update public.model_calls set unknown_since = unknown_since - interval '1 day'
      where lease_id = $1`,
    [work.picked['leaseId']],
  );
  for (let at = 0; at < 3; at += 1) {
    // eslint-disable-next-line no-await-in-loop
    await pass();
  }
  const later = [await callsOf(s, work), await attemptsOf(s, work)];
  expect(later[1]).toStrictEqual(before[1]);
  expect(later[0]).toMatchObject([{ state: 'liability_unknown', reserved: '500', outcome: null }]);
  // The write-off needs a person, an amount and a reason; then the call keeps its record.
  const body = {
    command: 'budget.write_off',
    operationId: randomUUID(),
    recordId: work.taskId,
    attemptId: work.picked['attemptId'],
    amountMinor: 0,
  };
  expect(codeOf(await asPerson(s, body))).not.toBe('applied');
  appliedDetail(
    await asPerson(s, {
      ...body,
      operationId: randomUUID(),
      reason: 'the provider confirmed by phone',
    }),
    'budget.write_off',
  );
  expect(await callsOf(s, work)).toMatchObject([
    { outcome: 'written_off', outcome_person_id: s.decider.personId },
  ]);
});

it('AW-10 no timer: only the commands a person sends reach the outcome and the write-off; no pass, sweep or worker does', () => {
  const root = join(import.meta.dirname, '..', '..');
  const callers: string[] = [];
  for (const dir of ['packages', 'apps']) {
    for (const file of readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })) {
      if (!/\.(ts|tsx|mjs)$/u.test(file) || file.includes('node_modules')) continue;
      const text = readFileSync(join(root, dir, file), 'utf8');
      if (/\b(recordOutcome|writeOff|resolveHeldCalls)\s*\(/u.test(text))
        callers.push(`${dir}/${file}`);
    }
  }
  expect(callers.toSorted()).toStrictEqual([
    'packages/core-commands/src/commands/budget-record-outcome.ts',
    'packages/core-commands/src/commands/budget-write-off.ts',
    // Defines `resolveHeldCalls`; its callers are the two below.
    'packages/core-runtime/src/recovery/broker-effect.ts',
    'packages/core-runtime/src/recovery/outcome.ts',
    'packages/core-runtime/src/recovery/write-off.ts',
  ]);
});
