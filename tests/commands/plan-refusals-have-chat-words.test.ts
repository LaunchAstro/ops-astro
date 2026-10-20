// SPDX-License-Identifier: AGPL-3.0-only
//
// #2175: a side chat asked through the owner's ChatGPT plan tells a refusal in
// chat words of its own, never the catch-all "could not be used". A refusal
// before the call says nothing was sent; a call held unknown after its write
// says no answer was kept and nothing was retried, by what the plan answered.
// Either way the message is kept, and no words name a token, an account by
// name or the answer's text.

import { describe, expect, it } from 'vitest';
import {
  planHeldWith,
  refusedWith,
  releasedWith,
} from '../../packages/core-commands/src/commands/conversation-replies.ts';

const BEFORE_SEND = [
  'SUBSCRIPTION_SIGN_IN_NEEDED',
  'SUBSCRIPTION_REFRESH_FAILED',
  'SUBSCRIPTION_STORE_FAILED',
  'SUBSCRIPTION_TOKEN_FILE_OPEN',
  'SUBSCRIPTION_NOT_OWNER_STARTED',
  'SUBSCRIPTION_OTHER_TENANT',
] as const;

const HELD: readonly (readonly [string | null, string])[] = [
  ['http_429', 'SUBSCRIPTION_PLAN_ALLOWANCE'],
  ['http_503', 'SUBSCRIPTION_PLAN_UNAVAILABLE'],
  ['http_500', 'SUBSCRIPTION_PLAN_UNAVAILABLE'],
  ['http_502', 'SUBSCRIPTION_PLAN_UNAVAILABLE'],
  ['http_504', 'SUBSCRIPTION_PLAN_UNAVAILABLE'],
  ['http_403', 'SUBSCRIPTION_NOT_ELIGIBLE'],
  ['http_400', 'SUBSCRIPTION_UNSUPPORTED_CAPABILITY'],
  ['http_401', 'SUBSCRIPTION_SIGN_IN_NEEDED'],
  ['http_404', 'SUBSCRIPTION_ANSWER_WITHHELD'],
  ['timeout', 'SUBSCRIPTION_ANSWER_WITHHELD'],
  [null, 'SUBSCRIPTION_ANSWER_WITHHELD'],
];

const EM_DASH = String.fromCodePoint(0x2014);

/** The words a held call is told in. */
function heldWords(providerCode: string | null): string {
  const reply = planHeldWith(providerCode);
  return reply.answered ? '' : reply.words;
}

/** Plain words: no catch-all, no em dash, no token or answer named. */
function plain(words: string): void {
  expect(words).not.toContain('could not be used');
  expect(words).not.toContain(EM_DASH);
  expect(words.toLowerCase()).not.toContain('token');
  expect(words).toContain('Your message is kept');
}

describe('#2175 a plan refusal before the call', () => {
  it.each(BEFORE_SEND)('%s has its own words: nothing was sent, the message kept', (code) => {
    const reply = refusedWith(code);
    expect(reply).toMatchObject({ answered: false, code });
    if (reply.answered) return;
    plain(reply.words);
    expect(reply.words).toContain('nothing was sent');
    expect(reply.words).toContain('ChatGPT');
  });

  it.each([...BEFORE_SEND, 'LOCAL_MODEL_REQUIRED'])(
    'released %s, keeps its own code and words',
    (code) => {
      const reply = releasedWith(code);
      expect(reply).toStrictEqual(refusedWith(code));
      expect(reply).toMatchObject({ code });
    },
  );

  it('the six read differently from one another', () => {
    const words = BEFORE_SEND.map((code) => {
      const reply = refusedWith(code);
      return reply.answered ? '' : reply.words;
    });
    expect(new Set(words).size).toBe(BEFORE_SEND.length);
  });
});

describe('#2175 a plan call held unknown after its write', () => {
  it.each(HELD)('%s reads as %s', (providerCode, code) => {
    const reply = planHeldWith(providerCode);
    expect(reply).toMatchObject({ answered: false, code });
    if (reply.answered) return;
    plain(reply.words);
    expect(reply.words).not.toContain('nothing was sent');
    expect(reply.words).toContain('no answer was kept');
    expect(reply.words).toContain('nothing was retried');
  });

  it('says what each answer means for the person', () => {
    expect(heldWords('http_429')).toMatch(/usage allowance/u);
    expect(heldWords('http_429')).toMatch(/resets/u);
    expect(heldWords('http_503')).toMatch(/unavailable just now/u);
    expect(heldWords('http_403')).toMatch(/choose another model/u);
    // The held words differ from the before-send words for the same code.
    const before = refusedWith('SUBSCRIPTION_SIGN_IN_NEEDED');
    expect(heldWords('http_401')).not.toBe(before.answered ? '' : before.words);
  });
});
