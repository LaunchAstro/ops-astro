// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-3 state-only left rule and three connector colours (TG-05, TG-06): the
// card's tone comes from its state alone, hover and selection never repaint
// the left rule, and the connector layer paints only --accent, dashed
// --warning and the grid quieter than --border.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gate, mountMap, run, step } from './mp-6-3-fixture.tsx';

const CSS = readFileSync(
  join(process.cwd(), 'packages/ui/src/styles/6b-execution-map.css'),
  'utf8',
);

/** The declarations of each rule whose selector matches `test`. */
const rules = (test: RegExp): string[] =>
  [...CSS.matchAll(/([^{}]+)\{([^}]*)\}/gu)]
    .filter((one) => test.test(one[1] ?? ''))
    .map((one) => one[2] ?? '');

describe('MP-6-3 left rule and colours', () => {
  it('MP-6-3 left rule and colours: tone by state only, the rule untouched by hover or selection, three line colours', async () => {
    const page = await mountMap(
      {
        plan: 'bound',
        steps: [step('a', [], ['r-a']), step('b', ['a'], ['r-b']), step('c', ['b'], ['r-c'])],
        nodes: [
          run('r-a', 'settled', { outcome: 'completed' }),
          run('r-b', 'in_progress', { whoseMove: { kind: 'agent', actorId: null } }),
          run('r-c', 'not_started'),
        ],
      },
      [gate('r-c', 'pending')],
    );
    const tone = (key: string) =>
      (page.find(`[data-tg-node="${key}"]`) as HTMLElement | null)?.dataset['tone'];
    expect([tone('a'), tone('b'), tone('c')]).toStrictEqual(['done', 'run', 'gate']);
    // The gate step is preselected; pressing never changes its tone.
    expect(page.find('[data-tg-node="c"]')?.getAttribute('aria-pressed')).toBe('true');
    for (const body of rules(/\.tg__node(:hover|\[aria-pressed)/u)) {
      expect(body).not.toMatch(/border-left|border-color\s*:/u);
    }
    expect(rules(/\.tg__node\[data-tone='gate'\]\s*$/u).join('')).toContain('var(--warning)');
    expect(rules(/\.tg__node\[data-tone='run'\]\s*$/u).join('')).toContain('var(--accent)');
    const paints = rules(/\.tg__(edge|arrow|join|lline)/u)
      .join(';')
      .match(/(?:stroke|fill|border-top-color|border-top)\s*:[^;]+/gu);
    const colours = new Set(paints?.flatMap((one) => one.match(/var\(--[a-z0-9-]+\)/gu) ?? []));
    expect([...colours].toSorted()).toStrictEqual([
      'var(--accent)',
      'var(--surface)',
      'var(--warning)',
    ]);
    expect(rules(/\.tg__edge--wait/u).join('')).toContain('stroke-dasharray');
    expect(rules(/^\s*\.tg__canvas\s*$/u).join('')).toContain(
      'color-mix(in oklch, var(--border) 55%',
    );
    expect(CSS).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|oklch\(\d/iu);
    await page.unmount();
  });
});
