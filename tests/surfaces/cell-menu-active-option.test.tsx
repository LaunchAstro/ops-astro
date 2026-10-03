// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// OW-129: the cell menu's active option stays the one the keys chose. Its
// height cap scrolls a long list, so the active option is scrolled into the
// list's view, and a list scrolling under a still pointer (which the browser
// reports as the pointer entering an option, without a move) does not take
// the active option from the keys. The browser proof is
// tests/visual/assignee-menu-active-visible.test.ts.

import { afterEach, expect, it } from 'vitest';
import {
  EDIT,
  EDITOR,
  OPTIONS,
  fire,
  one,
  open,
  press,
  unmount,
} from './mp-5-10-cells-fixture.tsx';

afterEach(unmount);

it('the active option is scrolled into the list view, nearest edge, as the keys move it', async () => {
  // jsdom draws nothing, so it has no scrollIntoView: the test lends one that records.
  const seen: [string, unknown][] = [];
  const proto = Element.prototype as { scrollIntoView?: ((how?: unknown) => void) | undefined };
  const had = proto.scrollIntoView;
  proto.scrollIntoView = function (this: Element, how?: unknown) {
    seen.push([this.textContent ?? '', how]);
  };
  try {
    const { board } = await open();
    await board.click(EDIT('menu', 'assignee'));
    await press(one(board, `${EDITOR('menu', 'assignee')} .sel__menu`), 'End');
  } finally {
    proto.scrollIntoView = had;
  }
  expect(seen.at(-1)).toStrictEqual(['Unassigned', { block: 'nearest' }]);
});

it('a pointer the list scrolls under does not take the active option; a moving one does', async () => {
  const { board } = await open();
  await board.click(EDIT('menu', 'assignee'));
  const menu = one(board, `${EDITOR('menu', 'assignee')} .sel__menu`);
  const options = board.all(OPTIONS('menu', 'assignee'));
  await fire(options[1] ?? null, new MouseEvent('mouseover', { bubbles: true }));
  expect(menu?.getAttribute('aria-activedescendant')).toBe(options[0]?.id);
  await fire(options[1] ?? null, new MouseEvent('mousemove', { bubbles: true }));
  expect(menu?.getAttribute('aria-activedescendant')).toBe(options[1]?.id);
});
