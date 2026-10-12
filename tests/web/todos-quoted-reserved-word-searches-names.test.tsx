// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// Proofs from the independent review of #1408 (round 1), retitled by what they prove; their bodies are as written.
/* eslint-disable no-await-in-loop -- the review's proof, kept as written */
import { afterEach, expect, it } from 'vitest';
import { typeInto, unmountAll } from './perspective-support.tsx';
import { keysOf, serving, TODOS, todos } from './todos-support.tsx';

afterEach(unmountAll);

it.each(['report', 'web', 'today', 'review'])(
  'plain or quoted %s can search task names',
  async (word) => {
    const row = { ...TODOS[5], title: `Prepare ${word}`, category: null, whoseMove: 'Team' };
    const { view } = await todos({ client: serving([row]).client });
    expect(keysOf(view)).toEqual(['Proj-Foxtrot']);
    const matches: boolean[] = [];
    for (const query of [word, `"${word}"`]) {
      await typeInto(view, '#todos-search', query);
      matches.push(keysOf(view).includes('Proj-Foxtrot'));
    }
    // Allow bare filter shorthand to remain if quoting supplies the name search.
    expect(matches.some(Boolean)).toBe(true);
  },
);
