// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A draft filed from a door says what it guessed (DN-02): the category, the
// due date, the owner and the priority. Once the person changes one of those,
// the sentence no longer describes the draft, so it stops claiming the guesses
// and keeps only where the draft was filed from.

import { afterEach, describe, expect, it } from 'vitest';
import { scopeOf } from '../../apps/web/src/screens/task/panel-host.ts';
import { draft, type View } from './draft-support.tsx';
import { typeInto, unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

const SCOPE = scopeOf({
  from: 'Search',
  subject: 'Checkout down',
  channel: 'search',
  channelLabel: 'Search',
  owner: { id: 'p-ada', name: 'Ada' },
  priority: 2,
});

const admission = (view: View): string => view.find('[data-draft-admission]')?.textContent ?? '';

describe('the draft’s admission sentence after the person edits a guess', () => {
  it('names the guesses while they stand', async () => {
    const { view } = await draft({ scope: SCOPE });
    expect(admission(view)).toBe(
      'New task, filed from Search. Guessed from “Checkout down”, the Search board: due in 7 days; owner Ada; priority P2 from the page. Nothing is stored until Create.',
    );
    await typeInto(view, '#panel-draft-name', 'Fix checkout');
    expect(admission(view)).toContain('Guessed from');
  });

  it.each([
    ['moving the due date', (view: View) => view.type('#panel-draft-due', '2026-12-01')],
    ['changing the category', (view: View) => view.choose('#panel-draft-category', 'content')],
    ['clearing the owner', (view: View) => view.choose('#panel-draft-owner', '')],
    ['changing the priority', (view: View) => view.choose('#panel-draft-priority', '4')],
  ])('%s leaves only where the draft was filed from', async (_edit, edit) => {
    const { view } = await draft({ scope: SCOPE });
    await edit(view);
    expect(admission(view)).toBe('New task, filed from Search. Nothing is stored until Create.');
  });
});
