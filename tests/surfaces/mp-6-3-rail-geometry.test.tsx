// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-3 Rail connectors with the geometry as specified (TG-06, DS-TASK-12
// `canvas`): node 208 by 136, column gap 48, row gap 28, pad-x 16, pad-top 12,
// stage row 16, pad-bottom 28. Columns are depths; a line leaves a card's
// right edge at mid-height and enters the next card's left edge; a fan-in
// shares its last segment through one junction. Rail only (R63): no study
// bar, no route facets.

import { describe, expect, it } from 'vitest';
import { mountMap, step } from './mp-6-3-fixture.tsx';

const GRAPH = {
  plan: 'bound' as const,
  steps: [step('a', []), step('b', ['a']), step('c', ['a']), step('d', ['b', 'c'])],
  nodes: [],
};

describe('MP-6-3 rail geometry', () => {
  it('MP-6-3 rail geometry: cards sit on the GEO grid by depth and the Rail paths join their ports', async () => {
    const page = await mountMap(GRAPH);
    const at = (key: string) => {
      const card = page.find(`[data-tg-node="${key}"]`) as HTMLElement;
      return [card.style.left, card.style.top];
    };
    // x = 16 + col × 256; y = 12 + 16 + 28 + row × 164.
    expect(at('a')).toStrictEqual(['16px', '56px']);
    expect(at('b')).toStrictEqual(['272px', '56px']);
    expect(at('c')).toStrictEqual(['272px', '220px']);
    expect(at('d')).toStrictEqual(['528px', '56px']);
    const canvas = page.find('.tg__canvas') as HTMLElement;
    // 2 × 16 + 3 × 208 + 2 × 48 wide; 12 + 16 + 28 + 2 × 136 + 28 + 28 high.
    expect(canvas.style.getPropertyValue('--tg-w')).toBe('752px');
    expect(canvas.style.getPropertyValue('--tg-h')).toBe('384px');
    expect(canvas.dataset['route']).toBe('rail');
    const paths = page.all('.tg__edge').map((one) => one.getAttribute('d'));
    expect(paths).toStrictEqual(
      expect.arrayContaining([
        'M224 124 H272',
        'M224 124 H248 V288 H272',
        'M480 124 H504',
        'M480 288 H504 V124',
        'M504 124 H528',
      ]),
    );
    expect(paths).toHaveLength(5);
    expect(
      page.all('.tg__join').map((one) => [one.getAttribute('cx'), one.getAttribute('cy')]),
    ).toStrictEqual([['504', '124']]);
    expect(page.all('.tg__stage').map((one) => one.textContent)).toStrictEqual([
      'Depth 1',
      'Depth 2',
      'Depth 3',
    ]);
    expect(page.find('.facet')).toBeNull();
    expect(page.text()).not.toMatch(/connection study/iu);
    await page.unmount();
  });
});
