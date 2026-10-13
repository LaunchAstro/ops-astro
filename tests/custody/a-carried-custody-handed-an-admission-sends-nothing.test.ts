// SPDX-License-Identifier: AGPL-3.0-only
//
// A paid send is admitted again at the handoff (`custody.ts`'s `admit`). The
// carried custody has no such judgement: a carried deployment refuses a paid
// call before anything is written (`broker-priced.ts`). Were an admission
// ever handed to it, the carried custody answers `CUSTODY_NOT_ADMITTED`
// before it joins a topic, offers the call or asks the admission: nothing is
// sent unjudged.

import { describe, expect, it } from 'vitest';
import {
  carriedCustody,
  type Custody,
  type Handoff,
} from '../../packages/core-custody/src/index.ts';

const KEY = Buffer.alloc(32, 7);

/** A carried custody, and a handoff, that record each thing they are asked. */
function recorded(asked: string[]): { readonly custody: Custody; readonly handoff: Handoff } {
  const noted = async <T>(step: string, answer: T): Promise<T> => {
    asked.push(step);
    return await Promise.resolve(answer);
  };
  const custody = carriedCustody({
    carriage: {
      join: async () => await noted('join', { ok: false, code: 'CARRIAGE_UNAVAILABLE' } as const),
    },
    keys: [KEY],
    key: KEY.toString('base64'),
  });
  const handoff: Handoff = {
    businessId: '0b6f2a8e-1c3d-4e5f-8a9b-0c1d2e3f4a5b',
    callId: '7d2c9e41-5a6b-4c7d-8e9f-a0b1c2d3e4f5',
    accessToken: 'never-read',
    offer: async () => await noted('offer', { ok: true } as const),
    fence: async () => await noted('fence', { ok: false, code: 'DECISION_STALE' } as const),
  };
  return { custody, handoff };
}

const REQUEST = {
  destination: 'openrouter',
  path: '/api/v1/chat/completions',
  method: 'POST',
  body: '{}',
  timeoutMs: 1_000,
  maxResponseBytes: 1_000,
} as const;

describe('a carried custody handed an admission', () => {
  it('answers CUSTODY_NOT_ADMITTED and joins, offers and asks nothing', async () => {
    const asked: string[] = [];
    const { custody, handoff } = recorded(asked);
    // An admission that would admit: the carried custody still takes none.
    const admit = async () => {
      asked.push('admit');
      return await Promise.resolve({ go: async () => await Promise.resolve(true), end: () => {} });
    };
    const outcome = await custody.dispatch('openrouter', REQUEST, undefined, admit, handoff);
    expect(outcome).toStrictEqual({
      kind: 'refused',
      started: false,
      code: 'CUSTODY_NOT_ADMITTED',
    });
    expect(asked).toStrictEqual([]);
  });
});
