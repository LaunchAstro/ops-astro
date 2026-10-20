// SPDX-License-Identifier: AGPL-3.0-only
//
// Each way a side-panel answer can end without a reply is told to the person
// in its own fixed words, never folded into the general "could not be used":
// the model's machine away or busy, the model out of reach, access being
// changed at that moment, a request that missed its moment, an answer that
// did not finish, one still on its way, and one that ended with nothing kept.
// A release for any other reason still reads as before.

import { describe, expect, it } from 'vitest';
import {
  refusedWith,
  releasedWith,
} from '../../packages/core-commands/src/commands/conversation-replies.ts';

const GENERAL = refusedWith('CALL_RELEASED');

const RELEASES = [
  'MODEL_MACHINE_AWAY',
  'MODEL_MACHINE_BUSY',
  'CARRIAGE_UNAVAILABLE',
  'AUTHORITY_BUSY',
  'SEND_LAPSED',
] as const;

const ENDINGS = ['ANSWER_ENDED', 'STILL_ANSWERING', 'DECISION_STALE'] as const;

const wordsOf = (reply: ReturnType<typeof refusedWith>): string =>
  reply.answered ? '' : reply.words;

describe('each new chat ending has its own words', () => {
  it.each(RELEASES)('a call released for %s says so, not the general words', (code) => {
    const reply = releasedWith(code);
    expect(reply).toMatchObject({ answered: false, code });
    expect(wordsOf(reply)).not.toBe(wordsOf(GENERAL));
  });

  it.each(ENDINGS)('%s has words of its own', (code) => {
    const reply = refusedWith(code);
    expect(reply).toMatchObject({ answered: false, code });
    expect(wordsOf(reply)).not.toBe(wordsOf(GENERAL));
  });

  it('no two endings share their words', () => {
    const words = [...RELEASES, ...ENDINGS].map((code) => wordsOf(refusedWith(code)));
    expect(new Set(words).size).toBe(words.length);
  });

  it('an answer that did not finish says so', () => {
    expect(wordsOf(refusedWith('DECISION_STALE'))).toContain('did not finish');
  });

  it('a release for any other reason reads as before', () => {
    expect(releasedWith('http_400')).toStrictEqual(GENERAL);
    expect(releasedWith('CUSTODY_CREDENTIAL_UNKNOWN')).toStrictEqual(GENERAL);
  });
});
