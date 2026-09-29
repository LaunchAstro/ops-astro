// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-9-1, the page kit's remaining page-level parts: bar lists, the meter as a
// page part, legends, the row that opens to its detail (CS-9.6), a term tip in
// a table header, and the rule that the page kit places the component kit's
// primitives without restyling them.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BarList,
  DataTable,
  DetailRow,
  Layer,
  Legend,
  PageMeter,
  barShares,
  type TableColumn,
} from '../../packages/ui/src/index.ts';
import { mount, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const widthOf = (element: Element | undefined | null): string =>
  (element as HTMLElement | null | undefined)?.style.width ?? '';

describe('MP-9-1 layer and row detail', () => {
  it('a row starts shut, opens to its detail and item list, and shuts again', async () => {
    mounted = await mount(
      <DetailRow
        title="Refresh the pricing page"
        trail="Saves 4h a month"
        detail="The page still quotes last year's rates."
        items={['Rates table', 'Footnote on GST']}
      />,
    );
    const row = mounted.find('details.opp') as HTMLDetailsElement | null;
    expect(row).not.toBeNull();
    expect(row?.open).toBe(false);
    expect(mounted.find('.opp__sum .opp__t')?.textContent).toBe('Refresh the pricing page');
    expect(mounted.find('.opp__sum .opp__save')?.textContent).toBe('Saves 4h a month');
    expect(mounted.find('.opp__body .opp__detail')?.textContent).toBe(
      "The page still quotes last year's rates.",
    );
    expect(mounted.all('.opp__items li').map((item) => item.textContent)).toEqual([
      'Rates table',
      'Footnote on GST',
    ]);
    await mounted.click('.opp__sum');
    expect(row?.open).toBe(true);
    await mounted.click('.opp__sum');
    expect(row?.open).toBe(false);
  });

  it('a row with no items draws no empty list, and a drawn open state wins', async () => {
    mounted = await mount(<DetailRow title="Quiet row" detail="Nothing listed." open />);
    expect((mounted.find('details.opp') as HTMLDetailsElement | null)?.open).toBe(true);
    expect(mounted.find('.opp__items')).toBeNull();
    expect(mounted.find('.opp__save')).toBeNull();
  });

  it('a layer summary opens and shuts its body', async () => {
    mounted = await mount(
      <Layer order={3} title="Already run">
        <p>older runs</p>
      </Layer>,
    );
    const layer = mounted.find('details.layer') as HTMLDetailsElement | null;
    expect(layer?.open).toBe(false);
    await mounted.click('.layer__sum');
    expect(layer?.open).toBe(true);
  });
});

describe('MP-9-1 bar lists draw each value against the largest', () => {
  it('shares run against the largest value, or against a whole when given', () => {
    const bars = [
      { id: 'a', label: 'Search', value: 40 },
      { id: 'b', label: 'Direct', value: 10 },
      { id: 'c', label: 'Email', value: 0 },
    ];
    expect(barShares(bars)).toEqual([100, 25, 0]);
    expect(barShares(bars, 80)).toEqual([50, 12.5, 0]);
  });

  it('never draws past the ends: no NaN, nothing negative, nothing over 100', () => {
    expect(barShares([{ id: 'a', label: 'A', value: 0 }])).toEqual([0]);
    expect(
      barShares([
        { id: 'a', label: 'A', value: -5 },
        { id: 'b', label: 'B', value: 5 },
        { id: 'c', label: 'C', value: Number.NaN },
      ]),
    ).toEqual([0, 100, 0]);
    expect(barShares([{ id: 'a', label: 'A', value: 30 }], 20)).toEqual([100]);
    expect(barShares([{ id: 'a', label: 'A', value: 3 }], 0)).toEqual([0]);
  });

  it('draws a named list, one row per bar, its label, track and value', async () => {
    mounted = await mount(
      <BarList
        label="Sessions by source"
        bars={[
          { id: 'a', label: 'Search', value: 1200 },
          { id: 'b', label: 'Direct', value: 300, display: '300 (20%)' },
        ]}
      />,
    );
    const list = mounted.find('.barlist');
    expect(list?.getAttribute('aria-label')).toBe('Sessions by source');
    const rows = mounted.all('.barlist__row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('.barlist__label')?.textContent).toBe('Search');
    expect(rows[0]?.querySelector('.barlist__val')?.textContent).toBe('1,200');
    expect(rows[1]?.querySelector('.barlist__val')?.textContent).toBe('300 (20%)');
    expect(widthOf(rows[0]?.querySelector('.barlist__fill'))).toBe('100%');
    expect(widthOf(rows[1]?.querySelector('.barlist__fill'))).toBe('25%');
    expect(rows[0]?.querySelector('.barlist__track')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('MP-9-1 meters as page parts draw the value, the whole and the target', () => {
  it('draws the kit meter with its value, whole, tone and target line', async () => {
    mounted = await mount(
      <PageMeter label="Hours used" value={30} max={40} target={32} tone="warn" display="30h" />,
    );
    expect(mounted.find('.pmeter__label')?.textContent).toBe('Hours used');
    expect(mounted.find('.pmeter__val')?.textContent).toBe('30h of 40');
    const meter = mounted.find('[role="meter"]');
    expect(meter?.className).toBe('meter');
    expect(meter?.getAttribute('aria-label')).toBe('Hours used');
    expect(meter?.getAttribute('aria-valuenow')).toBe('30');
    expect(meter?.getAttribute('aria-valuemax')).toBe('40');
    const fill = meter?.querySelector('.meter__fill');
    expect(widthOf(fill)).toBe('75%');
    expect(fill?.classList.contains('is-warn')).toBe(true);
    const target = meter?.querySelector('.meter__target') as HTMLElement | null;
    expect(target?.style.left).toBe('80%');
  });

  it('clamps an overrun and a target past the end, and draws no bar against no whole', async () => {
    mounted = await mount(<PageMeter label="Budget" value={50} max={40} target={90} />);
    expect(widthOf(mounted.find('.meter__fill'))).toBe('100%');
    expect((mounted.find('.meter__target') as HTMLElement | null)?.style.left).toBe('100%');
    await mounted.render(<PageMeter label="Budget" value={5} max={0} />);
    expect(mounted.find('[role="meter"]')).toBeNull();
    expect(mounted.find('.pmeter__val')?.textContent).toBe('5');
  });
});

describe('MP-9-1 legends name each series', () => {
  it('names each series in text, its key hidden from a screen reader', async () => {
    mounted = await mount(
      <Legend
        label="Series"
        items={[
          { id: 'this', label: 'This month', tone: 'ink' },
          { id: 'last', label: 'Last month', tone: 'muted' },
        ]}
      />,
    );
    const legend = mounted.find('.legend');
    expect(legend?.getAttribute('aria-label')).toBe('Series');
    const items = mounted.all('.legend li');
    expect(items.map((item) => item.textContent)).toEqual(['This month', 'Last month']);
    const key = items[1]?.querySelector('.legend__key');
    expect(key?.classList.contains('legend__key--muted')).toBe(true);
    expect(key?.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws nothing once it has no series', async () => {
    mounted = await mount(
      <Legend label="Series" items={[{ id: 'this', label: 'This month', tone: 'ink' }]} />,
    );
    expect(mounted.find('.legend')).not.toBeNull();
    await mounted.render(<Legend label="Series" items={[]} />);
    expect(mounted.find('.legend')).toBeNull();
  });
});

interface Row {
  readonly name: string;
  readonly hours: number;
}
const glossed: readonly TableColumn<Row>[] = [
  { id: 'name', label: 'Name', value: (row) => row.name },
  {
    id: 'hours',
    label: 'Billable',
    value: (row) => row.hours,
    numeric: true,
    term: 'Hours a client is charged for.',
  },
];

describe('MP-9-1 a term tip in a table header shows on focus and never sorts', () => {
  it('the glossed header explains itself, and only its sort button sorts', async () => {
    mounted = await mount(
      <DataTable
        label="Hours"
        columns={glossed}
        rows={[
          { name: 'A', hours: 1 },
          { name: 'B', hours: 3 },
        ]}
        rowKey={(row) => row.name}
      />,
    );
    const head = mounted.find('th[data-col="hours"]');
    const term = head?.querySelector('.term');
    expect(term?.getAttribute('tabindex')).toBe('0');
    expect(term?.textContent).toContain('Billable');
    const tip = mounted.find(`#${term?.getAttribute('aria-describedby') ?? 'none'}`);
    expect(tip?.getAttribute('role')).toBe('tooltip');
    expect(tip?.textContent).toBe('Hours a client is charged for.');
    expect(term?.closest('button')).toBeNull();

    await mounted.click('th[data-col="hours"] .term');
    expect(head?.getAttribute('aria-sort')).toBeNull();
    await act(async () => {
      (term as HTMLElement | null)?.focus();
      term?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(head?.getAttribute('aria-sort')).toBeNull();

    const sort = head?.querySelector('button.table__sort');
    expect(sort?.getAttribute('aria-label')).toBe('Sort by Billable');
    await mounted.click('th[data-col="hours"] button.table__sort');
    expect(head?.getAttribute('aria-sort')).toBe('descending');
    expect(mounted.all('tbody tr').map((row) => row.firstElementChild?.textContent)).toEqual([
      'B',
      'A',
    ]);
  });
});

// The component kit's classes the page kit places (MP-1-3): every class the
// kit's own stylesheet defines, and the ones its table, banner, meter, stat,
// term tip, facet and hint parts draw, which reach main when the kit lands.
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
  const defined = [...styles('2-primitives.css').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(
    (match) => match[1] ?? '',
  );
  return new Set([...KIT_PLACED, ...defined]);
}

// Every selector in a stylesheet whose first compound names a kit class: a rule
// that styles the primitive itself rather than the page part that holds it.
function restyled(css: string, kit: ReadonlySet<string>): readonly string[] {
  const found: string[] = [];
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const match of bare.matchAll(/([^{};]+)\{/g)) {
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
      const first = selector.trim().split(/\s*[>+~]\s*|\s+/)[0] ?? '';
      const classes = [...first.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1] ?? '');
      if (classes.some((name) => kit.has(name))) found.push(selector.trim());
    }
  }
  return found;
}

describe('MP-9-1 primitives placed not restyled', () => {
  it('the page kit stylesheet styles no kit primitive, only the page parts that hold them', () => {
    expect(restyled(styles('7-page-kit.css'), kitClasses())).toEqual([]);
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
