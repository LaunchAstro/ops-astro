// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-10, the three drops against a broker effect: the provider down (its 503),
// the connection cut with no answer, and our side lost mid-call (custody took
// the call, never answered, and the lease ran out). Each says which drop,
// whose fault and where the work got to, stops rather than redo work that may
// have happened, joins one report per outage, and comes back by itself only
// on the provider's declared proof that nothing happened. A call the provider
// never received may still arrive, so its lookup proves nothing. Failures that are
// no drop carry a fault from the evidence, `undetermined` where it cannot say.

import { expect, it as vitestIt } from 'vitest';
import {
  attemptsOf,
  callIn,
  callsOf,
  dropped,
  dropsOf,
  faultBroker,
  noDatabase,
  pass,
  s,
  toldOf,
  useFaultWorld,
  workerLost,
  world,
} from './aw-10-world.ts';
import { REPLAY_PATH } from '../../packages/core-connectors/src/index.ts';
import { liveWork } from '../runtime/schedules-harness.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useFaultWorld('aw10drop');

const THREE = [
  { mode: 'unavailable', cause: 'provider_unavailable', fault: 'provider', code: 'http_503' },
  { mode: 'cut', cause: 'connection_lost', fault: 'network', code: null },
] as const;

/** One drop: it says which, whose fault and where the work got to, stops whole, and a person is told. */
async function expectStopped(
  one: (typeof THREE)[number],
): Promise<{ cause: unknown; fault: unknown }> {
  const { work, result } = await dropped(one.mode);
  expect(result, one.mode).toMatchObject({
    ok: false,
    code: 'LIABILITY_UNKNOWN',
    heldMinor: 500,
    cause: one.cause,
    fault: one.fault,
    providerCode: one.code,
  });
  const [drop] = await dropsOf(s, work);
  expect(drop, one.mode).toMatchObject({
    cause: one.cause,
    fault: one.fault,
    providerCode: one.code,
    operation: 'model.replay_compose',
    reconcileMode: 'provider_lookup',
    reached: 'started',
    afterEvent: 1,
    unknownSince: expect.any(String),
    stepId: expect.any(String),
  });
  expect(await attemptsOf(s, work), one.mode).toMatchObject([
    { state: 'liability_unknown', drop_cause: one.cause, marked: true, held: 'held' },
  ]);
  expect(await toldOf(s, work), one.mode).toMatchObject([{ cause: one.cause, reactivated: false }]);
  return { cause: drop?.cause, fault: drop?.fault };
}

it('AW-10 three drops: provider down, connection cut and worker lost each say which drop, whose fault and where the work got to, and no two collapse', async () => {
  const seen: { cause: unknown; fault: unknown }[] = [];
  for (const one of THREE) {
    // eslint-disable-next-line no-await-in-loop
    seen.push(await expectStopped(one));
  }
  const lost = await workerLost();
  // No route to ask: the pass holds what the lost worker left and can prove nothing yet.
  await pass(s, { ...faultBroker(), routes: [] });
  const [drop] = await dropsOf(s, lost);
  expect(drop).toMatchObject({
    cause: 'worker_lost',
    fault: 'ours',
    providerCode: null,
    reached: 'started',
    afterEvent: 1,
  });
  expect(await attemptsOf(s, lost)).toMatchObject([
    { state: 'liability_unknown', drop_cause: 'worker_lost', marked: true, held: 'held' },
  ]);
  seen.push({ cause: drop?.cause, fault: drop?.fault });
  // Collapsing any pair would make two of these the same.
  expect(new Set(seen.map((one) => one.cause)).size).toBe(3);
  expect(new Set(seen.map((one) => one.fault)).size).toBe(3);
});

it('AW-10 three drops: a call the provider refused comes back by itself, with a person told; a call it never received stays held', async () => {
  world.provider.lookupMode('honest');
  const runs = [await dropped('unavailable'), await dropped('cut')];
  const lost = await workerLost();
  await pass();
  // The lost call never reached the provider and may still arrive: nothing comes back.
  expect(await attemptsOf(s, lost)).toMatchObject([{ state: 'liability_unknown', held: 'held' }]);
  expect(await callsOf(s, lost)).toMatchObject([{ state: 'liability_unknown' }]);
  // A hold that never ends by itself is not silent: the task's people are told of it.
  expect(await toldOf(s, lost)).toMatchObject([{ reactivated: false }]);
  for (const work of runs.map((one) => one.work)) {
    // eslint-disable-next-line no-await-in-loop
    const [first, second] = await attemptsOf(s, work);
    expect(first).toMatchObject({ state: 'liability_unknown', held: 'held' });
    expect(second).toMatchObject({ state: 'reserved', held: 'held' });
    // eslint-disable-next-line no-await-in-loop
    expect(await callsOf(s, work)).toMatchObject([{ state: 'released', outcome: null }]);
    // eslint-disable-next-line no-await-in-loop
    expect(await toldOf(s, work)).toMatchObject([{ reactivated: true }]);
  }
});

it('AW-10 one report per outage: runs dropped by one provider outage join one report, and it holds when the work comes back', async () => {
  world.provider.lookupMode('honest');
  const first = await dropped('unavailable');
  const second = await dropped('unavailable');
  const [a] = await toldOf(s, first.work);
  const [b] = await toldOf(s, second.work);
  expect(a?.['id']).toBe(b?.['id']);
  await pass();
  const after = [...(await toldOf(s, first.work)), ...(await toldOf(s, second.work))];
  expect(after).toMatchObject([
    { id: a?.['id'], reactivated: true },
    { id: a?.['id'], reactivated: true },
  ]);
});

it("AW-10 fault from evidence: a timeout is undetermined, a hostile answer the provider's, and each failure carries the refusal code or that none arrived", async () => {
  const cases = [
    { mode: 'slow', fault: 'undetermined', code: null },
    { mode: 'redirect', fault: 'provider', code: 'http_307' },
    { mode: 'malformed', fault: 'provider', code: null },
    { mode: 'oversized', fault: 'provider', code: null },
  ] as const;
  for (const one of cases) {
    // eslint-disable-next-line no-await-in-loop
    const work = await liveWork(s, `aw10 evidence ${one.mode}`, 2_000);
    world.provider.mode(one.mode);
    // eslint-disable-next-line no-await-in-loop
    const result = await callIn(s, work);
    expect(result, one.mode).toMatchObject({
      code: 'LIABILITY_UNKNOWN',
      cause: null,
      fault: one.fault,
      providerCode: one.code,
    });
    // eslint-disable-next-line no-await-in-loop
    expect(await callsOf(s, work), one.mode).toMatchObject([
      { state: 'liability_unknown', drop_cause: null, fault: one.fault, provider_code: one.code },
    ]);
  }
});

it("AW-10 a heartbeat provider start is not cleared by a call's absence proof: the step's own provider may have acted, so the pass leaves it unanswered and the hold whole", async () => {
  world.provider.lookupMode('honest');
  const work = await workerLost(s, true);
  // The silent call's request reaches the provider while it is down, which refuses it before
  // any work began: the honest lookup's declared proof, so the pass releases the call.
  world.provider.mode('unavailable');
  const [call] = await callsOf(s, work);
  await fetch(`${world.provider.origin}${REPLAY_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation_id: String(call?.['id']) }),
  }).then(async (response) => await response.text());
  const swept = await pass();
  expect(await callsOf(s, work)).toMatchObject([{ state: 'released', outcome: null }]);
  const reconciled = swept.ok ? (swept.businesses[0]?.reconciled ?? []) : [];
  expect(reconciled.filter((one) => one.attemptId === work.picked['attemptId'])).toMatchObject([
    { answer: 'unanswered' },
  ]);
  // The plan's attempt, then the launched one: held whole, and no attempt resumed after it.
  expect(await attemptsOf(s, work)).toMatchObject([
    { state: 'abandoned' },
    { id: work.picked['attemptId'], state: 'liability_unknown', marked: true, held: 'held' },
  ]);
});
