// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-5: one set of SVG chart primitives, no chart library (DS-COMP-27, 28,
// 29 and 40). The charts are driven the way a person drives them: the pointer
// enters a point, the keyboard tabs onto the chart and moves along it. Width is
// measured through the ResizeObserver the browser gives; jsdom has none, so a
// stand-in records the observers and the test reports sizes through them. The
// visual match at 1480, 900 and 390 runs on MP-1-7's harness and is `todo`
// until the pages it names and T4b1's signed-in fixture exist.

import { readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import { type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ColumnChart,
  DonutChart,
  Funnel,
  Gauge,
  LineChart,
  ScoreDial,
  Sparkline,
  axisTicks,
  scoreBand,
} from '../../packages/ui/src/kit/charts.tsx';
import { mount, type Mounted } from './mount.tsx';
import { primitiveSheets } from '../support/primitive-sheets.ts';
import {
  DAYS,
  enquiries,
  labelled,
  lastX,
  money,
  Observer,
  resize,
  standInResizeObserver,
} from './chart-driver.tsx';
import { noChartLibrary } from './chart-library.ts';

// Node's URL, not the document's: jsdom replaces the global one.
const root = fileURLToPath(new NodeURL('../..', import.meta.url));
const read = (path: string): string => readFileSync(path, 'utf8');
const sheet = primitiveSheets();
const rule = (selector: string): string => {
  const escaped = selector.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(sheet)?.[1] ?? '';
};
const html = (element: ReactElement): string => renderToStaticMarkup(element);

let mounted: Mounted | undefined;
standInResizeObserver();
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const viewBox = (): string => mounted?.find('svg')?.getAttribute('viewBox') ?? '';
const texts = (selector: string): readonly string[] =>
  (mounted?.all(selector) ?? []).map((node) => node.textContent ?? '');

/** A line, and a column chart with its dashed line. */
async function lineAndColumn(): Promise<void> {
  mounted = await mount(<LineChart name="Spend" labels={DAYS} series={[money]} />);
  await resize(600);
  expect(mounted.all('path.chart__line')).toHaveLength(1);

  await mounted.render(
    <ColumnChart name="Spend and enquiries" labels={DAYS} bars={[money]} line={enquiries} />,
  );
  await resize(600);
  expect(mounted.all('rect.chart__bar')).toHaveLength(5);
  const dashed = mounted.find('path.chart__line');
  expect(dashed?.getAttribute('stroke-dasharray')).toBe('4 3');
}

/** A donut with its centre value and label. */
function donutShape(): void {
  const donut = html(
    <DonutChart
      name="Where enquiries came from"
      centre="46"
      centreLabel="Enquiries"
      slices={[
        { label: 'Search', value: 30 },
        { label: 'Ads', value: 16 },
      ]}
    />,
  );
  expect(donut.match(/class="chart__slice"/gu)).toHaveLength(2);
  expect(donut).toContain('>46</text>');
  expect(donut).toContain('>Enquiries</text>');
}

/** The gauge's arc and target tick, and the score dial's bands. */
async function gaugeAndDials(): Promise<void> {
  if (mounted === undefined) throw new Error('mount a chart first');
  // The gauge's value arc stops at the value and its target tick sits at the target.
  await mounted.render(<Gauge name="Goal pacing" value={50} target={75} />);
  const tick = mounted.find('.chart__target');
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = ['x1', 'y1', 'x2', 'y2'].map((a) =>
    Number(tick?.getAttribute(a)),
  );
  const angle = (Math.atan2((y1 + y2) / 2 - 76.5, (x1 + x2) / 2 - 75) * 180) / Math.PI;
  expect(Math.round(angle)).toBe(-45);
  expect(mounted.find('.chart__value')?.textContent).toBe('50%');

  // Google's bands: 0 to 49 fail, 50 to 89 average, 90 to 100 good.
  expect([0, 49, 50, 89, 90, 100].map((score) => scoreBand(score))).toEqual([
    'bad',
    'bad',
    'warn',
    'warn',
    'ok',
    'ok',
  ]);
  expect(html(<ScoreDial label="Performance" score={92} />)).toContain('class="dial is-ok"');
  expect(html(<ScoreDial label="Performance" score={64} />)).toContain('class="dial is-warn"');
  expect(html(<ScoreDial label="Performance" score={31} />)).toContain('class="dial is-bad"');
}

/** The sparkline, and the funnel to true scale. */
async function inlineShapes(): Promise<void> {
  if (mounted === undefined) throw new Error('mount a chart first');
  const spark = html(<Sparkline name="Enquiries this week" values={[3, 5, 2, 6]} />);
  expect(spark).toContain('class="chart__line"');
  expect(spark).toContain('class="chart__end"');

  // True scale: each stage as wide as its count against the first real stage.
  await mounted.render(
    <Funnel
      name="Search to booking"
      steps={[
        { label: 'Sessions', count: 5000, context: true },
        { label: 'Enquiries', count: 400 },
        { label: 'Qualified', count: 100 },
        { label: 'Booked', count: 25 },
      ]}
    />,
  );
  const widths = mounted
    .all('.funnel__step:not(.funnel__step--ctx) .funnel__bg')
    .map((bar) => (bar as HTMLElement).style.getPropertyValue('--w'));
  expect(widths).toEqual(['100%', '25%', '6.25%']);
  expect(texts('.funnel__pct')).toEqual(['25%', '25%']);
  expect(mounted.find('.funnel__foot')?.textContent).toContain('6.25%');
}

describe('MP-1-5 chart primitives', () => {
  it.todo(
    "MP-1-5 visual match: matches mockup /dashboard/executive/, /connections/site-health/ and /clients/:client/workbench/search-seo/ at 1480, 900 and 390, light and dark (MP-1-7 harness; waits on those pages, MP-14-3 and the workbench slices, and T4b1's signed-in fixture)",
  );
});

describe('MP-1-5 chart primitives', () => {
  it('MP-1-5 no chart library: line, column with dashed line, donut with centre label, semicircle gauge with target, score dial with its bands, sparkline and true-scale funnel', async () => {
    noChartLibrary();
    await lineAndColumn();
    donutShape();
    await gaugeAndDials();
    await inlineShapes();
  });
});

describe('MP-1-5 chart primitives', () => {
  it('MP-1-5 line charts measure their width and redraw on show and resize', async () => {
    mounted = await mount(<LineChart name="Spend" labels={DAYS} series={[money]} />);
    // Hidden, the chart is zero wide and draws no series rather than a squashed one.
    expect(Observer.live).toHaveLength(1);
    expect(mounted.all('path.chart__line')).toHaveLength(0);
    await resize(600);
    expect(viewBox()).toBe('0 0 600 240');
    const wide = mounted.find('path.chart__line')?.getAttribute('d') ?? '';
    await resize(320);
    expect(viewBox()).toBe('0 0 320 240');
    const narrow = mounted.find('path.chart__line')?.getAttribute('d') ?? '';
    expect(narrow).not.toBe(wide);
    // The last point sits at the right edge of the plot at either width.
    expect(lastX(wide)).toBeGreaterThan(lastX(narrow));
    await mounted.unmount();
    mounted = undefined;
    expect(Observer.live).toHaveLength(0);
  });
});

describe('MP-1-5 chart primitives', () => {
  it('MP-1-5 a one-point line centres', async () => {
    mounted = await mount(
      <LineChart name="Spend" labels={['Today']} series={[{ label: 'Spend', values: [40] }]} />,
    );
    await resize(600);
    const dot = mounted.find('circle.chart__dot');
    const plot = mounted.find('.chart__plot');
    const left = Number(plot?.getAttribute('x'));
    const width = Number(plot?.getAttribute('width'));
    expect(Number(dot?.getAttribute('cx'))).toBeCloseTo(left + width / 2, 5);
  });
});

describe('MP-1-5 chart primitives', () => {
  it('MP-1-5 axis labels in mono 10 at 45%', async () => {
    mounted = await mount(<LineChart name="Spend" labels={DAYS} series={[money]} />);
    await resize(600);
    const labels = mounted.all('text.chart__axis');
    expect(labels.length).toBeGreaterThan(DAYS.length);
    for (const label of labels) {
      expect(label.getAttribute('font-size')).toBeNull();
      expect(label.getAttribute('style')).toBeNull();
    }
    expect(rule('.chart__axis')).toMatch(/font:\s*var\(--type-badge\)/u);
    expect(rule('.chart__axis')).toMatch(/opacity:\s*0\.45/u);
    const tokens = read(`${root}packages/ui/src/styles/1-tokens.css`);
    expect(tokens).toMatch(
      /--type-badge:\s*var\(--weight-regular\) var\(--text-micro\)\/var\(--leading-none\) var\(--font-mono\);/u,
    );
    expect(tokens).toMatch(/--text-micro:\s*10px;/u);
  });
});

describe('MP-1-5 chart primitives', () => {
  it('MP-1-5 an axis over tiny values reads honestly (no "1, 1, 1, 0, 0")', async () => {
    for (const max of [0.3, 1, 1.2, 3, 7, 12_400, 2_500_000]) {
      const labels = labelled(max);
      expect(new Set(labels).size, `${String(max)}: ${labels.join(', ')}`).toBe(labels.length);
      expect(axisTicks(0, max).at(-1)).toBeGreaterThanOrEqual(max);
    }
    expect(labelled(1.2)).toEqual(['0', '0.5', '1', '1.5']);
    // Counts are whole: one enquiry is one gridline, never a quarter.
    expect(labelled(1, true)).toEqual(['0', '1']);
    expect(labelled(3, true)).toEqual(['0', '1', '2', '3']);
    expect(labelled(12_400)).toEqual(['0', '5k', '10k', '15k']);
    // Far below one, across the point where numbers print in exponent form:
    // every label distinct, plain decimals, the top one above zero.
    for (const max of [0.000_004, 1e-7, 3e-9]) {
      const labels = labelled(max);
      expect(new Set(labels).size, `${String(max)}: ${labels.join(', ')}`).toBe(labels.length);
      for (const label of labels) expect(label).toMatch(/^\d+(\.\d+)?$/u);
      expect(Number(labels.at(-1))).toBeGreaterThanOrEqual(max);
    }
    expect(labelled(1e-7)).toEqual(['0', '0.000000025', '0.00000005', '0.000000075', '0.0000001']);
    // Nothing at all still draws one honest step, not a divide by zero.
    expect(labelled(0)).toEqual(['0', '1']);

    // Drawn: a week of single enquiries labels its axis 0 and 1, once each.
    mounted = await mount(
      <LineChart
        name="Enquiries"
        labels={DAYS}
        series={[{ label: 'Enquiries', values: [1, 1, 1, 0, 0], unit: 'count' }]}
      />,
    );
    await resize(600);
    expect(texts('text.chart__axis--y')).toEqual(['0', '1']);
  });
});
