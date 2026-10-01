// SPDX-License-Identifier: AGPL-3.0-only
//
// `AW-10 isolation`: two businesses, two clients, one grant each. A provider
// fault's records never cross: the pass run for one business asks about and
// moves only that business's calls; its drops are read only there; and a
// person's recorded outcome reaches only a task their own grant covers, so a
// person of the other business, a member granted on another client's task in
// the same business, and the external clients themselves are refused with
// nothing moved and no foreign id in the answer. Each crossing has its
// positive control.

import { beforeAll, expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/index.ts';
import { readCallDrops } from '../../packages/core-runtime/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { appliedDetail, asAgent, codeOf, type Schedules } from '../runtime/schedules-harness.ts';
import { openSecond } from '../runtime/t3b-harness.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import { cq8World } from '../runtime/cq-8-world.ts';
import {
  callsOf,
  dropped,
  noDatabase,
  outcome,
  pass,
  s,
  useFaultWorld,
  world,
  type Dropped,
} from './aw-10-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useFaultWorld('aw10iso');

let other: Schedules;

beforeAll(async () => {
  if (noDatabase) return;
  other = await openSecond(s, 'aw10-away');
  await openBilling(other);
}, 120_000);

const as = (on: Schedules, who: Member) => async (body: object) =>
  await executeCommand(on.db.app, on.business, who.presented, 'api', body as never);

const stateOf = async (on: Schedules, run: Dropped) =>
  (await callsOf(on, run.work)).map((call) => call['state']);

/** The drops of `taskId` read in `on`'s business. */
const read = async (on: Schedules, taskId: string) =>
  await on.db.app.withBusiness(on.business, async (tx) => await readCallDrops(tx, taskId));

/** A drop the lookup cannot answer yet, in `on`. */
async function stuck(on: Schedules): Promise<Dropped> {
  world.provider.lookupMode('unreachable');
  return await dropped('cut', on);
}

it('AW-10 isolation: business to business, the pass, the drops read and a recorded outcome reach only their own business', async () => {
  const mine = await stuck(s);
  const theirs = await stuck(other);
  // Each business's person names the other's task and attempt: not found, nothing named, nothing moved.
  for (const [on, run] of [
    [other, mine],
    [s, theirs],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop
    const refused = await outcome(on, run.work, 'nothing_happened', as(on, on.decider));
    expect(codeOf(refused)).not.toBe('applied');
    expect(JSON.stringify(refused)).not.toContain(run.work.taskId);
  }
  expect([await stateOf(s, mine), await stateOf(other, theirs)]).toStrictEqual([
    ['liability_unknown'],
    ['liability_unknown'],
  ]);
  // The pass for one business asks about its own calls only.
  world.provider.lookupMode('honest');
  await pass(s);
  expect([await stateOf(s, mine), await stateOf(other, theirs)]).toStrictEqual([
    ['released'],
    ['liability_unknown'],
  ]);
  // Drops are read in their own business only.
  expect(await read(other, mine.work.taskId)).toHaveLength(0);
  expect(await read(s, theirs.work.taskId)).toHaveLength(0);
  // Positive controls: each in its own business.
  expect(await read(s, mine.work.taskId)).toHaveLength(1);
  expect(await read(other, theirs.work.taskId)).toHaveLength(1);
  await pass(other);
  expect(await stateOf(other, theirs)).toStrictEqual(['released']);
});

it("AW-10 isolation: client to client, a grant on one client's task reaches no outcome on another client's, and the clients reach none", async () => {
  const a = await stuck(s);
  const b = await stuck(s);
  const clients = cq8World(s);
  const clientA = await clients.client(s.business, s.decider, 'aw10-client-a', a.work.taskId);
  const clientB = await clients.client(s.business, s.decider, 'aw10-client-b', b.work.taskId);
  const onA = await enrol(s.db.app, s.business, 'aw10-on-a');
  const onB = await enrol(s.db.app, s.business, 'aw10-on-b');
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, onA, 'decide', { kind: 'record', id: a.work.taskId }, false, 'billing');
    await grantTo(tx, onB, 'decide', { kind: 'record', id: b.work.taskId }, false, 'billing');
    await grantTo(tx, clientA, 'decide', { kind: 'record', id: a.work.taskId }, false, 'billing');
    await grantTo(tx, clientB, 'decide', { kind: 'record', id: b.work.taskId }, false, 'billing');
  });
  const crossings = [
    { who: onA, run: b },
    { who: onB, run: a },
    { who: clientA, run: b },
    { who: clientB, run: a },
    // R4: an external client's billing grant reaches no outcome on its own task either.
    { who: clientA, run: a },
  ];
  for (const crossing of crossings) {
    // eslint-disable-next-line no-await-in-loop
    const refused = await outcome(s, crossing.run.work, 'nothing_happened', as(s, crossing.who));
    expect(codeOf(refused)).toBe('SCOPE_NOT_GRANTED');
  }
  expect([await stateOf(s, a), await stateOf(s, b)]).toStrictEqual([
    ['liability_unknown'],
    ['liability_unknown'],
  ]);
  // The positive control: the member granted on b's task records b's, and only b's.
  appliedDetail(await outcome(s, b.work, 'nothing_happened', as(s, onB)), 'budget.record_outcome');
  expect([await stateOf(s, a), await stateOf(s, b)]).toStrictEqual([
    ['liability_unknown'],
    ['released'],
  ]);
});

it('AW-10 isolation: an agent under its live delegation records no outcome, and nothing moves', async () => {
  const run = await stuck(s);
  const credential = String(run.work.picked['credential']);
  const refused = await outcome(
    s,
    run.work,
    'nothing_happened',
    async (body) => await asAgent(s, body as never, credential),
  );
  expect(codeOf(refused)).not.toBe('applied');
  expect(await stateOf(s, run)).toStrictEqual(['liability_unknown']);
  // The positive control: the person holding budget permission records it.
  appliedDetail(await outcome(s, run.work, 'nothing_happened'), 'budget.record_outcome');
  expect(await stateOf(s, run)).toStrictEqual(['released']);
});
