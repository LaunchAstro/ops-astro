// SPDX-License-Identifier: AGPL-3.0-only
//
// GPT on the owner's ChatGPT plan can end a side-panel answer before the
// model is asked: Codex signed out, the plan's week kept for others, or the
// plan's usage not confirmed. Each is told to the person in its own fixed
// words, never folded into the general "could not be used", and none names a
// time: the answer carries no reset time, so the words cannot promise one.

import { describe, expect, it } from 'vitest';
import {
  refusedWith,
  releasedWith,
} from '../../packages/core-commands/src/commands/conversation-replies.ts';

const GENERAL = refusedWith('CALL_RELEASED');
const GPT_ENDINGS = ['GPT_SIGNED_OUT', 'GPT_WEEK_RESERVED', 'GPT_USAGE_UNKNOWN'] as const;

const wordsOf = (reply: ReturnType<typeof refusedWith>): string =>
  reply.answered ? '' : reply.words;

describe("each way GPT on the owner's plan can end", () => {
  it.each(GPT_ENDINGS)('a call released for %s says so, not the general words', (code) => {
    const reply = releasedWith(code);
    expect(reply).toMatchObject({ answered: false, code });
    expect(wordsOf(reply)).not.toBe(wordsOf(GENERAL));
  });

  it('no two of them, nor the plan at its limit, share their words', () => {
    const words = [...GPT_ENDINGS, 'LOCAL_PLAN_LIMIT'].map((code) => wordsOf(releasedWith(code)));
    expect(new Set(words).size).toBe(words.length);
  });

  it.each(GPT_ENDINGS)('%s names no time and keeps the message', (code) => {
    const words = wordsOf(releasedWith(code));
    expect(words).not.toMatch(/\d/u);
    expect(words).toContain('nothing was sent');
    expect(words).toContain('Your message is kept');
  });

  it('says signed out, and the week, in so many words', () => {
    expect(wordsOf(releasedWith('GPT_SIGNED_OUT'))).toContain('signed in');
    expect(wordsOf(releasedWith('GPT_WEEK_RESERVED'))).toContain('week');
  });
});
