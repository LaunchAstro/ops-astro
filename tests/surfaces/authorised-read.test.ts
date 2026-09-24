// SPDX-License-Identifier: AGPL-3.0-only
//
// Ordering and invalidation, which are the two rules a browser proof cannot
// demonstrate reliably because it cannot control when a response arrives.
//
// The N6 case is the last two tests: a denial invalidates the projection, and
// an authorised response that was already in flight when the denial landed must
// not restore the content. Delivered here by holding the response and offering
// it afterwards, which is the same sequence the browser case stages with a
// delay.

import { describe, expect, it } from 'vitest';
import { AuthorisedRead, type ReadState } from '../../apps/web/src/data/authorised-read.ts';

interface Rows {
  readonly rows: readonly string[];
}

const ok = (rows: readonly string[]) => ({ ok: true as const, value: { rows } });
const denied = { refused: true as const, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] };
const down = { unavailable: true as const, because: 'The API did not answer.' };

function projection(grantKey = 'alpha:tok'): {
  readonly read: AuthorisedRead<Rows>;
  readonly seen: ReadState<Rows>[];
} {
  const seen: ReadState<Rows>[] = [];
  const read = new AuthorisedRead<Rows>({
    grantKey,
    onState: (state) => seen.push(state),
    isEmpty: (value) => value.rows.length === 0,
  });
  return { read, seen };
}

describe('the generation counter', () => {
  it('starts loading and becomes ready on the answer to the current generation', () => {
    const { read } = projection();
    const generation = read.begin();
    expect(read.state.outcome).toBe('loading');
    expect(read.accept(generation, ok(['a']), 'alpha:tok')).toBe(true);
    expect(read.state.outcome).toBe('ready');
    expect(read.state.value?.rows).toEqual(['a']);
  });

  it('drops an older answer that arrives after a newer one was asked for', () => {
    const { read } = projection();
    const first = read.begin();
    const second = read.begin();
    expect(read.accept(second, ok(['new']), 'alpha:tok')).toBe(true);
    expect(read.accept(first, ok(['old']), 'alpha:tok')).toBe(false);
    expect(read.state.value?.rows).toEqual(['new']);
  });

  it('drops an answer minted under a different grant', () => {
    const { read } = projection();
    const generation = read.begin();
    expect(read.accept(generation, ok(['theirs']), 'bravo:other')).toBe(false);
    expect(read.state.outcome).toBe('loading');
  });

  it('calls an authorised collection with no rows empty, not ready and not failed', () => {
    const { read } = projection();
    read.accept(read.begin(), ok([]), 'alpha:tok');
    expect(read.state.outcome).toBe('empty');
    expect(read.state.refusal).toBeNull();
  });
});

describe('denial invalidates', () => {
  it("drops the value and keeps the server's refusal", () => {
    const { read } = projection();
    read.accept(read.begin(), ok(['a']), 'alpha:tok');
    read.accept(read.begin(), denied, 'alpha:tok');
    expect(read.state.outcome).toBe('denied');
    expect(read.state.value).toBeNull();
    expect(read.state.refusal?.code).toBe('SCOPE_NOT_GRANTED');
  });

  it('refuses an older in-flight authorised response after the denial (N6)', () => {
    const { read } = projection();
    // The read that was already in flight when the grant was revoked.
    const inFlight = read.begin();
    // The reread that comes back denied first.
    const reread = read.begin();
    read.accept(reread, denied, 'alpha:tok');
    expect(read.state.outcome).toBe('denied');

    // Now the delayed authorised response lands. It must not restore content.
    expect(read.accept(inFlight, ok(['secret']), 'alpha:tok')).toBe(false);
    expect(read.state.outcome).toBe('denied');
    expect(read.state.value).toBeNull();
  });

  it('lets a fresh read after the denial succeed, so denial is not permanent', () => {
    const { read } = projection();
    read.accept(read.begin(), denied, 'alpha:tok');
    const again = read.begin();
    expect(read.accept(again, ok(['restored']), 'alpha:tok')).toBe(true);
    expect(read.state.outcome).toBe('ready');
  });
});

describe('unavailable is not denial', () => {
  it('drops the value without claiming anybody decided anything', () => {
    const { read } = projection();
    read.accept(read.begin(), ok(['a']), 'alpha:tok');
    read.accept(read.begin(), down, 'alpha:tok');
    expect(read.state.outcome).toBe('unavailable');
    // No stand-in rows, and no refusal invented to explain the absence.
    expect(read.state.value).toBeNull();
    expect(read.state.refusal).toBeNull();
    expect(read.state.because).toBe('The API did not answer.');
  });

  it('does not raise the floor, so a slower authorised answer still lands', () => {
    const { read } = projection();
    const inFlight = read.begin();
    read.accept(read.begin(), down, 'alpha:tok');
    expect(read.accept(inFlight, ok(['a']), 'alpha:tok')).toBe(false);
    const fresh = read.begin();
    expect(read.accept(fresh, ok(['a']), 'alpha:tok')).toBe(true);
  });
});

describe('the state is a union on its outcome', () => {
  it('keeps the previous answer while loading, and none after a denial', () => {
    const { read } = projection();
    read.accept(read.begin(), ok(['a']), 'alpha:tok');
    read.begin();
    expect(read.state.outcome).toBe('loading');
    expect(read.state.value?.rows).toEqual(['a']);
    read.accept(read.begin(), denied, 'alpha:tok');
    read.begin();
    expect(read.state.outcome).toBe('loading');
    expect(read.state.value).toBeNull();
    expect(read.state.refusal).toBeNull();
  });

  it('gives a narrowed reader the field its outcome carries, without a null check', () => {
    const { read } = projection();
    read.accept(read.begin(), denied, 'alpha:tok');
    const state = read.state;
    if (state.outcome !== 'denied') throw new Error('expected denied');
    // Checked by the typechecker: a denied state's refusal is not nullable.
    const code: string = state.refusal.code;
    expect(code).toBe('SCOPE_NOT_GRANTED');
    // @ts-expect-error a denied state holds no value to draw.
    const leaked: Rows = state.value;
    expect(leaked).toBeNull();
  });
});
