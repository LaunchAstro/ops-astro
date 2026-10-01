// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-9-1: the page kit places the component kit's primitives and never
// restyles them (lane FINAL-FOLD). The page kit's stylesheet is read as it
// ships, and the check is given hostile stylesheets of its own.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The component kit's classes the page kit places (MP-1-3): every class the
// kit's two stylesheets define, and the ones its table, banner, meter, stat,
// term tip, facet and hint parts draw.
const KIT_PLACED = [
  'banner',
  'banner__body',
  'banner__x',
  'banner--info',
  'facet',
  'facet__num',
  'facets',
  'hint',
  'hint__act',
  'hint__text',
  'marker',
  'meter',
  'meter__fill',
  'meter__target',
  'meter--stat',
  'sec',
  'sec__head',
  'stat',
  'stat__foot',
  'stat__label',
  'stat__num',
  'stat__of',
  'table',
  'table__arrow',
  'table__sort',
  'tablewrap',
  'term',
  'term__tip',
  'visually-hidden',
];

const styles = (name: string): string =>
  readFileSync(join(process.cwd(), 'packages/ui/src/styles', name), 'utf8');

function kitClasses(): ReadonlySet<string> {
  const defined = ['2-primitives.css', '2-controls-and-marks.css'].flatMap((sheet) =>
    [...styles(sheet).matchAll(/\.(-?[_a-zA-Z][\w-]*)/gu)].map((match) => match[1] ?? ''),
  );
  return new Set([...KIT_PLACED, ...defined]);
}

// Every selector in a stylesheet whose first compound names a kit class: a rule
// that styles the primitive itself rather than the page part that holds it.
function restyled(css: string, kit: ReadonlySet<string>): readonly string[] {
  const found: string[] = [];
  const bare = css.replaceAll(/\/\*[\s\S]*?\*\//gu, ' ');
  for (const match of bare.matchAll(/([^{};]+)\{/gu)) {
    const prelude = (match[1] ?? '').trim();
    if (prelude.startsWith('@') || prelude === '') continue;
    let depth = 0;
    let current = '';
    const selectors: string[] = [];
    for (const character of prelude) {
      if (character === '(') depth += 1;
      if (character === ')') depth -= 1;
      if (character === ',' && depth === 0) {
        selectors.push(current);
        current = '';
      } else current += character;
    }
    selectors.push(current);
    for (const selector of selectors) {
      const first = selector.trim().split(/\s*[>+~]\s*|\s+/u)[0] ?? '';
      const classes = [...first.matchAll(/\.(-?[_a-zA-Z][\w-]*)/gu)].map((m) => m[1] ?? '');
      // A kit state (`is-on`) beside a page part's own class is the part's state,
      // not a restyle; a compound of kit states alone restyles every primitive.
      const primitive = classes.some((name) => kit.has(name) && !name.startsWith('is-'));
      const statesOnly = classes.length > 0 && classes.every((name) => kit.has(name));
      if (primitive || statesOnly) found.push(selector.trim());
    }
  }
  return found;
}

describe('MP-9-1 primitives placed not restyled', () => {
  it('the page kit stylesheet styles no kit primitive, only the page parts that hold them', () => {
    expect(restyled(styles('7-page-kit.css'), kitClasses())).toEqual([]);
  });

  it('MP-7-10 the Team panel stylesheet styles no kit primitive either', () => {
    expect(restyled(styles('10-team.css'), kitClasses())).toEqual([]);
  });

  it('MP-7-3 and MP-8-4 the notifications and ledger stylesheets style no kit primitive either', () => {
    expect(restyled(styles('8-notifications.css'), kitClasses())).toEqual([]);
    expect(restyled(styles('9-ledger.css'), kitClasses())).toEqual([]);
  });

  it('the kit marks sheet counts too: a restyle of its avatar or term tip is found', () => {
    const kit = kitClasses();
    expect(restyled('.av { x: 1 }', kit)).not.toEqual([]);
    expect(restyled('.term__tip { x: 1 }', kit)).not.toEqual([]);
    expect(restyled('.is-on { x: 1 }', kit)).not.toEqual([]);
    expect(restyled('.av.is-on { x: 1 }', kit)).not.toEqual([]);
    expect(restyled('.tmc__p.is-on .tmc__n { x: 1 }', kit)).toEqual([]);
  });

  it('the check finds a restyle however the stylesheet hides it', () => {
    const kit = kitClasses();
    const planted = [
      '.stat { color: red; }',
      '/* .statrow {} */ .meter__fill { width: 1px; }',
      '@media (width <= 640px) {\n  .page { x: 1 }\n  .TABLE, .table { x: 1 }\n}',
      '.barlist,\n\t.banner--info { x: 1 }',
      ':is(.term) .x { x: 1 }',
      'div.hint > .y { x: 1 }',
    ];
    for (const css of planted) expect(restyled(css, kit), css).not.toEqual([]);
    expect(restyled('.statrow > .stat { x: 1 } .statrow .stat__num { x: 1 }', kit)).toEqual([]);
  });
});
