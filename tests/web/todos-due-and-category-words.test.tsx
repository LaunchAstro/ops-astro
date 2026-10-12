// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The to-dos search's due words take the `due:` form for each urgency it
// knows (today, overdue, soon), as the plain words do, and a category is read
// from three letters of its label or more: fewer is a name word.

import { afterEach, expect, it } from 'vitest';
import { typeInto, unmountAll } from './perspective-support.tsx';
import { todos } from './todos-support.tsx';

afterEach(unmountAll);

const SEARCH = '#todos-search';
const reading = (view: Awaited<ReturnType<typeof todos>>['view']) =>
  view.find('[data-todos-reading]')?.textContent;

it.each(['soon', 'overdue'])(
  'due:%s reads as the same due scope as the plain word',
  async (word) => {
    const { view } = await todos();
    await typeInto(view, SEARCH, word);
    const expected = reading(view);
    expect(expected).toMatch(/^Reading this as: due /u);
    await typeInto(view, SEARCH, `due:${word}`);
    expect(reading(view)).toBe(expected);
  },
);

it('two letters of a category label are a name word; three are the category', async () => {
  const { view } = await todos();
  await typeInto(view, SEARCH, 'co');
  expect(reading(view)).toBe('Reading this as: name “co”');
  await typeInto(view, SEARCH, 'con');
  expect(reading(view)).not.toBe('Reading this as: name “con”');
  expect(reading(view)).toMatch(/Content/u);
});
