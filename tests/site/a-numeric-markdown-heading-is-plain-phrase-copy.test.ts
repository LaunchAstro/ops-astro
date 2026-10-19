// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proof on #2094 (S2094-1), assertions unchanged: a Markdown heading
// that opens with a number, `# 24 hour support`, is plain phrase copy on
// either side of a rewrite. Only an ordered-list marker (`1. `, `1) `) at a
// phrase's start writes markup, and that stays refused
// (a-live-correction-replaces-a-phrase-on-one-line.test.ts).

import { expect, it } from 'vitest';
import { checkEnvelope, wordPairRefusal } from '../../packages/core-connectors/src/index.ts';

it('a Markdown heading opening with a number is plain phrase copy, either side of a rewrite', () => {
  const path = 'src/pages/support.md';
  const results = [
    { word: '24 hour support', replacement: 'Support around the clock' },
    { word: 'Support around the clock', replacement: '24 hour support' },
  ].map(({ word, replacement }) => {
    expect(wordPairRefusal({ word, replacement })).toBeUndefined();
    const before = `# ${word}\n`;
    const after = `# ${replacement}\n`;
    return checkEnvelope({ files: [{ path, before, after }] }, { path, word, replacement });
  });
  expect(results).toMatchObject([{ ok: true }, { ok: true }]);
});
