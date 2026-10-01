// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12, part one: the four shared fakes (TEST.md 4), each capability the
// cases lean on, all of them run with every egress denied.

import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HARNESS_PINNED_WINDOW } from '../../packages/core-runtime/src/index.ts';
import { denyEgress, type EgressGuard } from './deny-egress.ts';
import { CORPUS_WINDOWS, fakeClock, sourceCorpus } from './fake-clock-corpus.ts';
import { fakeEffect, type EffectState } from './fake-effect.ts';
import { digestOf, fakeModel, SLOW_MS, unitsOf, type ModelReply } from './fake-model.ts';

const WINDOW = HARNESS_PINNED_WINDOW.contextUnits;
const LINE = { input: 'Summarise fp-s-001.', text: 'A grounded summary.', outputUnits: 30 };

let guard: EgressGuard;
beforeEach(() => {
  guard = denyEgress();
});
afterEach(() => {
  guard.release();
  expect(guard.attempts).toEqual([]);
});

const settled = async <T>(promise: Promise<T>): Promise<T | 'pending'> =>
  await Promise.race([
    promise,
    new Promise<'pending'>((done) => {
      setImmediate(() => done('pending'));
    }),
  ]);

describe('AW-12 fakes: FP-M, the replay model provider', () => {
  it('answers a scripted request by digest, with usage priced by the replay book', async () => {
    const { client } = fakeModel([LINE], fakeClock());
    expect(client.window).toBe(HARNESS_PINNED_WINDOW);
    const reply = await client.complete({ model: 'replay-1', input: LINE.input });
    const input = unitsOf(LINE.input);
    expect(reply).toEqual({
      kind: 'answer',
      text: 'A grounded summary.',
      usage: { inputUnits: input, outputUnits: 30, priceMinor: input + 60 },
    });
  });

  it('an unscripted request is a typed refusal naming its digest, never an improvised answer', async () => {
    const { client } = fakeModel([LINE], fakeClock());
    const asked = { model: 'replay-1', input: 'Something else.' };
    expect(await client.complete(asked)).toEqual({ kind: 'unscripted', digest: digestOf(asked) });
  });

  it('a request past the declared window is refused with its overflow size', async () => {
    const { client } = fakeModel([LINE], fakeClock());
    const reply = await client.complete({ model: 'replay-1', input: 'x'.repeat(WINDOW + 25) });
    expect(reply).toEqual({ kind: 'overflow', overflowUnits: 25 });
    const fits = await client.complete({ model: 'replay-1', input: 'x'.repeat(WINDOW) });
    expect(fits.kind).toBe('unscripted');
  });
});

describe('AW-12 fakes: FP-M, its hostile modes', () => {
  it('the hostile modes: no usage, refusal with and without a code, a schema failure', async () => {
    const { client, fixture } = fakeModel([LINE], fakeClock());
    const ask = async (): Promise<ModelReply> =>
      await client.complete({ model: 'replay-1', input: LINE.input });
    fixture.mode('no_usage');
    expect(await ask()).toMatchObject({ kind: 'answer', usage: null });
    fixture.mode('refuse_with_code');
    expect(await ask()).toEqual({ kind: 'provider_refusal', providerCode: 'refused' });
    fixture.mode('refuse_without_code');
    expect(await ask()).toEqual({ kind: 'provider_refusal', providerCode: null });
    fixture.mode('schema_fail');
    expect(await ask()).toMatchObject({ kind: 'malformed' });
    // The switch is on the fixture alone: the client an entry holds has none.
    expect(Object.keys(client).toSorted()).toEqual(['complete', 'window']);
  });

  it('slow answers on the controlled clock, past a deadline; silent never answers', async () => {
    const clock = fakeClock();
    const { client, fixture } = fakeModel([LINE], clock);
    fixture.mode('slow');
    const slow = client.complete({ model: 'replay-1', input: LINE.input });
    clock.advance(SLOW_MS - 1);
    expect(await settled(slow)).toBe('pending');
    clock.advance(1);
    expect(await settled(slow)).toMatchObject({ kind: 'answer' });
    fixture.mode('silent');
    const silent = client.complete({ model: 'replay-1', input: LINE.input });
    clock.advance(SLOW_MS * 100);
    expect(await settled(silent)).toBe('pending');
  });
});

describe('AW-12 fakes: FP-E, the fake effect provider', () => {
  it('a reversible copy correction: written, read back, written back', () => {
    const { service, fixture } = fakeEffect('Old copy.');
    expect(service.write({ mode: 'reconcilable', key: 'ref-1', body: 'New copy.' })).toEqual({
      kind: 'accepted',
      revision: 2,
    });
    expect(service.read()).toMatchObject({ revision: 2, body: 'New copy.' });
    service.write({ mode: 'reconcilable', key: 'ref-2', body: fixture.history[0]?.body ?? '' });
    expect(service.read()).toMatchObject({ revision: 3, body: 'Old copy.' });
    expect(fixture.log.map((write) => write.key)).toEqual(['ref-1', 'ref-2']);
  });

  it('all five reconciliation states are reachable on demand', () => {
    const { service, fixture } = fakeEffect();
    const states: [EffectState, string, string][] = [
      ['accepted_says_so', 'accepted', 'accepted'],
      ['not_accepted_says_so', 'not_accepted', 'not_accepted'],
      ['accepted_cannot_say', 'no_answer', 'cannot_say'],
      ['unreadable', 'no_answer', 'unreadable'],
      ['ambiguous', 'ambiguous', 'ambiguous'],
    ];
    for (const [state, answered, reconciled] of states) {
      fixture.drive(state);
      expect(service.write({ mode: 'reconcilable', key: state, body: state }).kind).toBe(answered);
      expect(service.reconcile('reconcilable', state)).toBe(reconciled);
    }
    fixture.drive('unreadable');
    expect(service.read()).toBe('unreadable');
    // A reference the service never received: it did not accept, and says so.
    expect(service.reconcile('reconcilable', 'never-sent')).toBe('not_accepted');
  });

  it('the three reconcile modes: a token lands once, a reference is asked about, neither cannot be', () => {
    const { service, fixture } = fakeEffect();
    service.write({ mode: 'naturally_idempotent', key: 'token-1', body: 'Once.' });
    service.write({ mode: 'naturally_idempotent', key: 'token-1', body: 'Once.' });
    expect(fixture.history.length).toBe(2);
    expect(service.reconcile('naturally_idempotent', 'token-1')).toBe('accepted');
    service.write({ mode: 'neither', key: null, body: 'Blind.' });
    expect(service.reconcile('neither', 'anything')).toBe('not_reconcilable');
    expect(fixture.log).toHaveLength(3);
  });
});

describe('AW-12 fakes: FP-C and FP-S', () => {
  it('the clock moves only when the test moves it', async () => {
    const clock = fakeClock(1_000);
    const woken = clock.until(5_000);
    expect(await settled(woken)).toBe('pending');
    expect(clock.now()).toBe(1_000);
    clock.advance(4_000);
    expect(await settled(woken)).toBeUndefined();
    expect(() => clock.advance(-1)).toThrow(RangeError);
  });

  it('the corpus is several windows in all, each document inside one, and the same on every build', () => {
    const corpus = sourceCorpus();
    const total = corpus.reduce((sum, document) => sum + unitsOf(document.body), 0);
    expect(total).toBeGreaterThanOrEqual(WINDOW * CORPUS_WINDOWS);
    expect(CORPUS_WINDOWS).toBeGreaterThanOrEqual(3);
    expect(Math.max(...corpus.map((document) => unitsOf(document.body)))).toBeLessThan(WINDOW);
    expect(new Set(corpus.map((document) => document.id)).size).toBe(corpus.length);
    expect(sourceCorpus()).toEqual(corpus);
    expect(corpus[0]).toMatchObject({ id: 'fp-s-001', revision: 1 });
    expect(corpus[0]?.digest).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('AW-12 fakes: all egress denied', () => {
  it('the guard refuses a socket, a lookup and a fetch, and records each (the control)', async () => {
    const control = denyEgress();
    try {
      await expect(fetch('http://203.0.113.9/collect')).rejects.toThrow(/egress denied/u);
      const refused = await new Promise<string>((done) => {
        const outbound = request({ host: '127.0.0.1', port: 9, path: '/' });
        outbound.on('error', (error) => done(error.message));
        outbound.end();
      });
      expect(refused).toMatch(/egress denied/u);
      expect(control.attempts).toEqual(['fetch http://203.0.113.9/collect', 'socket 9']);
    } finally {
      control.release();
    }
  });
});
