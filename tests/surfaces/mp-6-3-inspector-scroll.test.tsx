// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-3 the inspector's preselected node is scrolled into view (TG-07, D-15):
// the waiting gate is preselected and the map's own scroll box is moved so
// that card sits in the middle of it, rather than describing a card the reader
// cannot see. Clicking a card selects it; clicking again clears the inspector.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { gate, mountMap, run, step } from './mp-6-3-fixture.tsx';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MP-6-3 inspector scroll', () => {
  it('MP-6-3 inspector scroll: the preselected gate step is scrolled into the box and fills the inspector', async () => {
    const lefts: number[] = [];
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, 'scrollLeft', 'set').mockImplementation((value: number) => {
      lefts.push(value);
    });
    const page = await mountMap(
      {
        plan: 'bound',
        steps: [
          step('a', [], ['r-a']),
          step('b', ['a']),
          step('c', ['b']),
          step('d', ['c'], ['r-d']),
          step('e', ['d']),
        ],
        nodes: [run('r-a', 'settled', { outcome: 'completed' }), run('r-d', 'not_started')],
      },
      [gate('r-d', 'pending', 3)],
    );
    // d is at x 784: its middle (888) to the box's middle (200) is 688.
    expect(lefts.at(-1)).toBe(688);
    expect(page.find('[data-tg-node="d"]')?.getAttribute('aria-pressed')).toBe('true');
    const inspector = page.find('[data-map="inspector"]') as HTMLElement | null;
    expect(inspector?.dataset['mapStep']).toBe('d');
    expect(inspector?.textContent).toContain('Binds v3 · sha256:');
    await page.click('[data-tg-node="d"]');
    expect(page.find('[data-map="inspector"]')?.textContent).toContain('Nothing selected.');
    await page.click('[data-tg-node="a"]');
    expect((page.find('[data-map="inspector"]') as HTMLElement | null)?.dataset['mapStep']).toBe(
      'a',
    );
    expect(lefts.at(-1)).toBe(0);
    await page.unmount();
  });
});
