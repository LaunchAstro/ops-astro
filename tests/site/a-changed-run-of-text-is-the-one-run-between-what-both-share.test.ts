// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2105): the review's text difference is C80's comparison placed, not copied: the one
// run between what the two texts share at each end, never overlapping itself when a repeated
// character is shared from both ends.

import { describe, expect, it } from 'vitest';
import { changedText } from '../../packages/core-connectors/src/index.ts';

describe('the changed run of text', () => {
  it('is null for equal text and the run between the shared ends otherwise', () => {
    expect(changedText('same', 'same')).toBeNull();
    expect(changedText('We fix bikes.', 'We fix e-bikes.')).toStrictEqual({
      at: 7,
      removed: '',
      added: 'e-',
    });
    expect(changedText('Open 9 to 5', 'Open 8 to 6')).toStrictEqual({
      at: 5,
      removed: '9 to 5',
      added: '8 to 6',
    });
  });

  it('never counts a repeated character as shared from both ends', () => {
    expect(changedText('aaa', 'aa')).toStrictEqual({ at: 2, removed: 'a', added: '' });
    expect(changedText('', 'new')).toStrictEqual({ at: 0, removed: '', added: 'new' });
  });
});
