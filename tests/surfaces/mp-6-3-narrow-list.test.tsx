// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-3 a vertical list at 900 and below with no overflow at 390 (DS-TASK-12
// `list`, D-16): every card carries its dependency in words in the one DOM;
// at 900 and below the cards drop their positions and go full width, and the
// lines and stage labels go. A long digest and run id wrap rather than
// widening the page. The width-and-theme captures measure the page itself.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gate, mountMap, run, step } from './mp-6-3-fixture.tsx';

const CSS = readFileSync(
  join(process.cwd(), 'packages/ui/src/styles/6b-execution-map.css'),
  'utf8',
);
const narrow = CSS.slice(CSS.indexOf('@media (width <= 900px)'));

describe('MP-6-3 narrow list no overflow', () => {
  it('MP-6-3 narrow list no overflow: one DOM says each dependency in words, and the narrow rules list it and wrap', async () => {
    const page = await mountMap(
      {
        plan: 'bound',
        steps: [step('a', [], ['r-a']), step('b', ['a'], [`r-${'b'.repeat(80)}`])],
        nodes: [
          run('r-a', 'settled', { outcome: 'completed' }),
          run(`r-${'b'.repeat(80)}`, 'not_started'),
        ],
      },
      [gate(`r-${'b'.repeat(80)}`, 'pending')],
    );
    expect(page.all('[data-map="dependency"]').map((one) => one.textContent)).toStrictEqual([
      'Starts the plan',
      'After a',
    ]);
    expect(narrow).toMatch(/\.tg__edges,\s*\.tg__stage\s*\{\s*display: none;/u);
    expect(narrow).toMatch(/\.tg__node\s*\{[^}]*position: static;[^}]*width: 100%;/u);
    expect(narrow).toMatch(/\.tg__ndep\s*\{\s*display: block;/u);
    expect(narrow).toMatch(/\.tg__scroll\s*\{\s*overflow: visible;/u);
    expect(CSS).toMatch(/\.tg__insp \.gate__say,[^{]*\{\s*overflow-wrap: anywhere;/u);
    await page.unmount();
  });
});
