// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-10's invariant, `positive_proof_or_stop`: after a provider fault, the
// work resumes only when the provider answers the lookup with a code the
// operation declared at registration as proof that nothing happened (AW-01's
// `nothingHappened`). Every other answer stops the work and records that the
// pass could establish nothing: the provider saying it did the work, a
// malformed, oversized, redirected or slow answer, an answer that claims
// nothing happened in its own words, no answer at all, and an operation whose
// lookup is not declared. The hold stays whole until a person decides.

import { expect, it as vitestIt } from 'vitest';
import {
  REPLAY_LOOKUP_PATH,
  type ReplayLookupMode,
} from '../../packages/core-connectors/src/index.ts';
import {
  attemptsOf,
  callsOf,
  dropped,
  faultBroker,
  noDatabase,
  pass,
  s,
  useFaultWorld,
  world,
  type Dropped,
} from './aw-10-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useFaultWorld('aw10proof');

/** Whether the pass resumed the dropped work, and what it wrote on the call. */
async function after(run: Dropped) {
  const [first, second] = await attemptsOf(s, run.work);
  const [call] = await callsOf(s, run.work);
  return {
    resumed: second !== undefined,
    firstHeld: first?.['held'],
    call: call?.['state'],
    note: call?.['reconcile_note'],
  };
}

/** One drop the provider never began, then one pass with the lookup answering as `mode`. */
async function askedAs(mode: ReplayLookupMode, broker = faultBroker()) {
  world.provider.lookupMode(mode);
  const run = await dropped('unavailable');
  await pass(s, broker);
  return await after(run);
}

const STOPS: readonly ReplayLookupMode[] = [
  'malformed',
  'oversized',
  'redirect',
  'slow',
  'claims_success',
  'unreachable',
];

it("positive_proof_or_stop: the work resumes only on the provider's declared proof that nothing happened; every other answer stops it", async () => {
  // The provider began the work and its answer never came: the lookup truly says it did.
  world.provider.lookupMode('honest');
  const begun = await dropped('slow');
  expect(world.provider.processed.has(String((await callsOf(s, begun.work))[0]?.['id']))).toBe(
    true,
  );
  await pass();
  expect(await after(begun)).toMatchObject({ resumed: false, call: 'liability_unknown' });
  for (const mode of STOPS) {
    // eslint-disable-next-line no-await-in-loop
    expect(await askedAs(mode), mode).toMatchObject({
      resumed: false,
      firstHeld: 'held',
      call: 'liability_unknown',
    });
  }
  // The positive control: the declared code, and only it, resumes the work.
  expect(await askedAs('honest')).toMatchObject({ resumed: true, call: 'released' });
});

it('AW-10 hostile provider: a malformed, oversized, redirected, slow or unreachable lookup answer leaves the hold whole and says the pass could establish nothing', async () => {
  for (const mode of ['malformed', 'oversized', 'redirect', 'slow', 'unreachable'] as const) {
    // eslint-disable-next-line no-await-in-loop
    const seen = await askedAs(mode);
    expect(seen, mode).toMatchObject({ resumed: false, call: 'liability_unknown' });
    expect(String(seen.note), mode).toMatch(/^could establish nothing: /u);
  }
});

it('AW-10 no false proof: an answer claiming success in its own words, the provider saying it began, or an undeclared lookup is never proof', async () => {
  const claimed = await askedAs('claims_success');
  expect(claimed).toMatchObject({ resumed: false, call: 'liability_unknown' });
  expect(String(claimed.note)).toMatch(/not declared proof/u);
  // An operation whose provider declares no lookup is a person's to decide; the pass never asks it.
  const before = world.provider.seen.length;
  const { lookup: _lookup, ...adapter } = faultBroker().providers.get('replay') ?? {};
  const undeclared = { ...faultBroker(), providers: new Map([['replay', adapter as never]]) };
  const run = await askedAs('honest', undeclared);
  expect(run).toMatchObject({ resumed: false, call: 'liability_unknown' });
  expect(String(run.note)).toMatch(/a person records/u);
  // One request: the call itself. The lookup was never sent.
  expect(world.provider.seen.length).toBe(before + 1);
});

/** How many lookups the stand-in has been sent. */
const asked = (): number =>
  world.provider.seen.filter((one) => one.path === REPLAY_LOOKUP_PATH).length;

it('AW-10 hostile provider: a provider silent to one lookup is not asked again in that pass, so it cannot stall the sweep, and every call it holds says the pass established nothing', async () => {
  world.provider.lookupMode('slow');
  const runs = [await dropped('unavailable'), await dropped('unavailable')];
  const before = asked();
  await pass();
  // One lookup timed out; the rest of the pass waited on no other.
  expect(asked() - before).toBe(1);
  for (const run of runs) {
    // eslint-disable-next-line no-await-in-loop
    const seen = await after(run);
    expect(seen).toMatchObject({ resumed: false, call: 'liability_unknown' });
    expect(String(seen.note)).toMatch(/^could establish nothing: /u);
  }
});
