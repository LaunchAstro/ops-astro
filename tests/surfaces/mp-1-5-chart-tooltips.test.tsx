// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-5, the charts' tooltips and their place on the gallery: line, column
// and donut charts show each value on hover and keyboard focus (R57), a
// second quantity gets its own labelled right-hand axis (R58), and the charts
// are their own unit on the component gallery. Driven in jsdom through
// chart-driver.tsx; the shapes and sizes are in mp-1-5-charts.test.tsx. Every chart's
// accessible name is checked here too.

import { act, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ColumnChart,
  DonutChart,
  Funnel,
  Gauge,
  LineChart,
  ScoreDial,
  Sparkline,
} from '../../packages/ui/src/kit/charts.tsx';
import { GALLERY } from '../../packages/ui/src/kit/gallery.tsx';
import { mount, type Mounted } from './mount.tsx';
import {
  DAYS,
  enquiries,
  focus,
  hover,
  key,
  leave,
  money,
  resize,
  standInResizeObserver,
} from './chart-driver.tsx';

let mounted: Mounted | undefined;
standInResizeObserver();
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const tip = (): string => mounted?.find('[role="tooltip"]')?.textContent ?? '';
const tabStops = (): readonly Element[] => mounted?.all('[tabindex="0"]') ?? [];
const texts = (selector: string): readonly string[] =>
  (mounted?.all(selector) ?? []).map((node) => node.textContent ?? '');

/** The line chart: hover, keys, and the second quantity on its own right axis. */
async function lineTooltips(): Promise<void> {
  mounted = await mount(
    <LineChart
      name="Money line"
      labels={DAYS}
      series={[
        money,
        {
          ...enquiries,
          label: 'Managed spend',
          values: [1000, 2500, 2000, 1500, 500],
          unit: 'money',
        },
      ]}
    />,
  );
  await resize(600);
  // Hover: the point's values appear, and go when the pointer leaves.
  const points = mounted.all('.chart__hit');
  expect(points).toHaveLength(DAYS.length);
  await hover(points[2]);
  expect(tip()).toContain('Wed 3');
  expect(tip()).toContain('$140');
  expect(tip()).toContain('$2,000');
  await leave(points[2]);
  expect(mounted.find('[role="tooltip"]')).toBeNull();
  // Keyboard: one tab stop; focus shows the value; arrows walk the points.
  expect(tabStops()).toHaveLength(1);
  await focus(tabStops()[0]);
  expect(tip()).toContain('Mon 1');
  await key(document.activeElement, 'ArrowRight');
  expect(tip()).toContain('Tue 2');
  expect(document.activeElement?.getAttribute('aria-label')).toContain('Tue 2');
  await key(document.activeElement, 'End');
  expect(tip()).toContain('Fri 5');
  // The second quantity is on its own right axis, labelled, never divided onto the first.
  expect(mounted.find('.chart__axis-title--right')?.textContent).toBe('Managed spend');
  expect(mounted.find('.chart__axis-title--left')?.textContent).toBe('Spend');
  expect(texts('text.chart__axis--right')).toEqual(['$0', '$1k', '$2k', '$3k']);
  const second = mounted.all('path.chart__line')[1]?.getAttribute('d') ?? '';
  const ys = [...second.matchAll(/,([\d.]+)/gu)].map((m) => Number(m[1]));
  const plot = mounted.find('.chart__plot');
  const top = Number(plot?.getAttribute('y'));
  const height = Number(plot?.getAttribute('height'));
  expect(ys[1]).toBeCloseTo(top + height - (2500 / 3000) * height, 1);
}

/** The column chart: a bar's day and both quantities, the line's on the right. */
async function columnTooltips(): Promise<void> {
  if (mounted === undefined) throw new Error('mount a chart first');
  // Column: each bar's day shows on hover and focus, the line's quantity on the right.
  await mounted.render(
    <ColumnChart
      name="Spend against genuine enquiries"
      labels={DAYS}
      bars={[money]}
      line={enquiries}
    />,
  );
  await resize(600);
  await hover(mounted.all('.chart__hit')[4]);
  expect(tip()).toContain('Fri 5');
  expect(tip()).toContain('$100');
  expect(tip()).toContain('3');
  expect(mounted.find('.chart__axis-title--right')?.textContent).toBe('Genuine enquiries');
}

/** The donut: a slice's label, value and share, on hover and focus. */
async function donutTooltips(): Promise<void> {
  if (mounted === undefined) throw new Error('mount a chart first');
  // Donut: the slice's label, value and share.
  await mounted.render(
    <DonutChart
      name="Enquiry sources"
      centre="40"
      centreLabel="Enquiries"
      slices={[
        { label: 'Search', value: 30 },
        { label: 'Ads', value: 10 },
      ]}
    />,
  );
  const slices = mounted.all('.chart__slice');
  await hover(slices[1]);
  expect(tip()).toContain('Ads');
  expect(tip()).toContain('10');
  expect(tip()).toContain('25%');
  await leave(slices[1]);
  expect(tabStops()).toHaveLength(1);
  await focus(tabStops()[0]);
  expect(tip()).toContain('Search');
  expect(tip()).toContain('75%');
}

describe('MP-1-5 chart primitives', () => {
  it('MP-1-5 line, column and donut charts show value tooltips on hover and keyboard focus (R57), and a second quantity gets its own labelled right-hand axis (R58)', async () => {
    await lineTooltips();
    await columnTooltips();
    await donutTooltips();
  });
});

describe('MP-1-5 chart primitives', () => {
  it('MP-1-5 CS-1.3: value tooltips on hover and keyboard focus: each point, bar or slice shows its value (and label, share for a slice); hover or focus a day to read spend and genuine enquiries', async () => {
    mounted = await mount(
      <ColumnChart
        name="Spend against genuine enquiries"
        labels={DAYS}
        bars={[money]}
        line={enquiries}
      />,
    );
    await resize(900);
    await hover(mounted.all('.chart__hit')[2]);
    expect(tip()).toMatch(/Wed 3.*Spend.*\$140.*Genuine enquiries.*2/su);
    await leave(mounted.all('.chart__hit')[2]);
    await focus(tabStops()[0]);
    await key(document.activeElement, 'ArrowRight');
    await key(document.activeElement, 'ArrowRight');
    await key(document.activeElement, 'ArrowRight');
    expect(tip()).toMatch(/Thu 4.*Spend.*\$60.*Genuine enquiries.*1/su);
    // The tooltip describes the focused day for a screen reader too.
    const active = document.activeElement;
    expect(active?.getAttribute('aria-describedby')).toBe(mounted.find('[role="tooltip"]')?.id);
    await act(() => {
      (active as SVGElement).blur();
    });
    expect(mounted.find('[role="tooltip"]')).toBeNull();
  });
});

describe('MP-1-5 chart primitives', () => {
  it('MP-1-5 shown in its own unit on the component gallery', async () => {
    const charts = GALLERY.filter((entry) =>
      ['DS-COMP-27', 'DS-COMP-28', 'DS-COMP-29', 'DS-COMP-40'].includes(entry.id),
    );
    expect(charts.map((entry) => entry.id)).toEqual([
      'DS-COMP-27',
      'DS-COMP-28',
      'DS-COMP-29',
      'DS-COMP-40',
    ]);
    for (const entry of charts)
      expect(entry.interactive, entry.id).toBe(
        entry.id !== 'DS-COMP-29' && entry.id !== 'DS-COMP-40',
      );
    // Every state of every chart unit draws a chart.
    mounted = await mount(
      <>
        {charts.map((entry) => (
          <section key={entry.id} data-unit={entry.id}>
            {entry.states.map((state) => (
              <figure key={state.label} data-state={state.label}>
                {state.render()}
              </figure>
            ))}
          </section>
        ))}
      </>,
    );
    await resize(600);
    for (const figure of mounted.all('[data-state]'))
      expect(
        figure.querySelector('svg, .funnel'),
        (figure as HTMLElement).dataset['state'] ?? '',
      ).not.toBeNull();
    const drawn = GALLERY.flatMap((entry) => entry.states.map((state) => state.label));
    for (const shape of [
      'Line',
      'Two quantities, right axis',
      'One point',
      'Column with dashed line',
      'Donut with centre label',
      'Gauge with target',
      'Score dials, three bands',
      'Sparkline',
      'True-scale funnel',
    ])
      expect(drawn, shape).toContain(shape);
  });
});

describe('MP-1-5 chart primitives', () => {
  it.todo(
    'MP-1-5 owner check: the Executive page, every chart draws and hovering or tabbing onto a point shows its value (staging, S0-1; again in MP-14-3)',
  );
});

describe('MP-1-5 chart primitives', () => {
  it('MP-1-5 every chart has an accessible name', async () => {
    const charts: readonly [string, ReactElement][] = [
      ['Money line', <LineChart name="Money line" labels={DAYS} series={[money]} />],
      [
        'Blocked requests',
        <ColumnChart name="Blocked requests" labels={DAYS} bars={[money]} line={enquiries} />,
      ],
      [
        'Enquiry sources',
        <DonutChart
          name="Enquiry sources"
          centre="46"
          centreLabel="Enquiries"
          slices={[{ label: 'Search', value: 46 }]}
        />,
      ],
      ['Goal pacing', <Gauge name="Goal pacing" value={40} target={60} />],
      ['Performance', <ScoreDial label="Performance" score={92} />],
      ['Enquiries this week', <Sparkline name="Enquiries this week" values={[3, 5]} />],
      [
        'Search to booking',
        <Funnel name="Search to booking" steps={[{ label: 'Enquiries', count: 4 }]} />,
      ],
    ];
    // All seven at once, each in its own holder, so each name is read from its own chart.
    mounted = await mount(
      <>
        {charts.map(([name, chart]) => (
          <div key={name} data-chart={name}>
            {chart}
          </div>
        ))}
      </>,
    );
    await resize(600);
    for (const [name] of charts) {
      const named = mounted.find(
        `[data-chart="${name}"] :is([role="img"], [role="group"])[aria-label]`,
      );
      expect(named?.getAttribute('aria-label'), name).toContain(name);
    }
  });
});
