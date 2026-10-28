// SPDX-License-Identifier: AGPL-3.0-only
//
// A comment's mentions are capped, so the access walk each mention runs inside
// the task's lock is bounded by the cap, not by the route's body limit.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mentionsOf } from '../../packages/core-commands/src/commands/tasks-comment-mentions.ts';

/** The most people one comment may name. */
const MENTIONS_LIMIT = 25;

const ids = (count: number): string[] => Array.from({ length: count }, () => randomUUID());

describe('a comment naming too many people', () => {
  it('is refused naming mentions, past the cap', () => {
    const outcome = mentionsOf(ids(MENTIONS_LIMIT + 1));
    expect(outcome).toMatchObject({
      refusal: { code: 'FIELD_VALUE_INVALID', names: ['mentions'] },
    });
  });

  it('is kept at the cap', () => {
    expect(mentionsOf(ids(MENTIONS_LIMIT))).toHaveLength(MENTIONS_LIMIT);
  });

  it('counts one person named twice in two letter cases once', () => {
    const one = randomUUID();
    const named = [...ids(MENTIONS_LIMIT - 1), one, one.toUpperCase()];
    expect(mentionsOf(named)).toHaveLength(MENTIONS_LIMIT + 1);
  });
});
