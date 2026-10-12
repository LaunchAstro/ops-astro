// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// An unreadable board recovery copy blocks board edits until the person
// discards it from the board's notice; then the next edit is sent.

import { expect, it } from 'vitest';
import { draftTab } from './projects-draft-app-support.tsx';
import { BoardEditServer, open, SLOT, submit } from './p05-board-edit-support.ts';

it('an unreadable board recovery copy can be discarded to resume edits', async () => {
  const storage = draftTab();
  storage.setItem(SLOT, '{"bogus":1}');
  const world = new BoardEditServer('none');
  const app = await open(world, storage);
  expect(app.view.find('[data-board-edit-problem]')).not.toBeNull();
  const discard = app.view
    .all('button')
    .find((button) =>
      /discard.*(unreadable|recovery|saved).*copy/iu.test(button.textContent ?? ''),
    );
  expect(
    discard,
    'the person needs a discard action to clear the stored copy blocking board edits',
  ).toBeDefined();
  if (!(discard instanceof HTMLElement)) throw new Error('Missing recovery discard control');
  await app.act(() => discard.click());
  await app.tick();
  expect(app.view.find('[data-board-edit-problem]')).toBeNull();
  await submit(app, 'title');
  expect(world.applications).toHaveLength(1);
});
