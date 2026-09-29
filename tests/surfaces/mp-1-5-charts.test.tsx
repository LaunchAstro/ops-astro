// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-5: one set of SVG chart primitives, no chart library (DS-COMP-27, 28,
// 29 and 40). The charts are driven the way a person drives them: the pointer
// enters a point, the keyboard tabs onto the chart and moves along it. Width is
// measured through the ResizeObserver the browser gives; jsdom has none, so a
// stand-in records the observers and the test reports sizes through them. The
// visual match at 1480, 900 and 390 is MP-1-7's harness and is `todo`.

import { readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import { act, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ColumnChart,
  DonutChart,
  Funnel,
  Gauge,
  LineChart,
  ScoreDial,
  Sparkline,
  axisTicks,
  formatTick,
  scoreBand,
} from '../../packages/ui/src/kit/charts.tsx';
import { GALLERY } from '../../packages/ui/src/kit/gallery.tsx';
import { mount, type Mounted } from './mount.tsx';

// Node's URL, not the document's: jsdom replaces the global one.
const root = fileURLToPath(new NodeURL('../..', import.meta.url));
const read = (path: string): string => readFileSync(path, 'utf8');
const sheet = read(`${root}packages/ui/src/styles/2-primitives.css`);
const rule = (selector: string): string => {
  const escaped = selector.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(sheet)?.[1] ?? '';
};
const html = (element: ReactElement): string => renderToStaticMarkup(element);

/** The browser's ResizeObserver, stood in: every observer and what it watches. */
class Observer {
  static live: Observer[] = [];
  readonly watched: Element[] = [];
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    Observer.live.push(this);
  }
  observe(target: Element): void {
    this.watched.push(target);
  }
  unobserve(): void {}
  disconnect(): void {
    Observer.live = Observer.live.filter((o) => o !== this);
  }
  report(width: number): void {
    const entries = this.watched.map(
      (target) => ({ target, contentRect: { width, height: 0 } }) as unknown as ResizeObserverEntry,
    );
    this.callback(entries, this as unknown as ResizeObserver);
  }
}
/** Tell every live observer its element is now `width` wide, the way a show or a resize does. */
const resize = async (width: number): Promise<void> => {
  await act(async () => {
    for (const observer of Observer.live) observer.report(width);
  });
};

let mounted: Mounted | undefined;
beforeEach(() => {
  Observer.live = [];
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Observer;
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const DAYS = ['Mon 1', 'Tue 2', 'Wed 3', 'Thu 4', 'Fri 5'];
const money = { label: 'Spend', values: [120, 80, 140, 60, 100], unit: 'money' } as const;
const enquiries = {
  label: 'Genuine enquiries',
  values: [1, 0, 2, 1, 3],
  unit: 'count',
  axis: 'right',
} as const;

const hover = async (target: Element | null | undefined): Promise<void> => {
  if (target == null) throw new Error('nothing to hover');
  await act(async () => {
    target.dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }),
    );
  });
};
const leave = async (target: Element | null | undefined): Promise<void> => {
  if (target == null) throw new Error('nothing to leave');
  await act(async () => {
    target.dispatchEvent(
      new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }),
    );
  });
};
const key = async (target: Element | null, name: string): Promise<void> => {
  await act(async () => {
    target?.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });
};
const focus = async (target: Element | null | undefined): Promise<void> => {
  await act(async () => {
    (target as SVGElement | null)?.focus();
  });
};
/** The x of a path's last point. */
const lastX = (d: string): number => Number(/([\d.]+),[\d.]+$/u.exec(d)?.[1]);
/** An axis from zero to `max`, as its labels read. */
const labelled = (max: number, integer = false): readonly string[] => {
  const ticks = axisTicks(0, max, { integer });
  return ticks.map((t) => formatTick(t, ticks));
};
const tip = (): string => mounted?.find('[role="tooltip"]')?.textContent ?? '';
const tabStops = (): readonly Element[] => mounted?.all('[tabindex="0"]') ?? [];
const viewBox = (): string => mounted?.find('svg')?.getAttribute('viewBox') ?? '';
const texts = (selector: string): readonly string[] =>
  (mounted?.all(selector) ?? []).map((node) => node.textContent ?? '');

describe('MP-1-5 chart primitives', () => {
  it.todo(
    'MP-1-5 visual match: matches mockup /dashboard/executive/, /connections/site-health/ and /clients/:client/workbench/search-seo/ at 1480, 900 and 390, light and dark (MP-1-7)',
  );

  it('MP-1-5 no chart library: line, column with dashed line, donut with centre label, semicircle gauge with target, score dial with its bands, sparkline and true-scale funnel', async () => {
    // Nothing but React and the kit is imported, and no manifest names a chart package.
    const source = read(`${root}packages/ui/src/kit/charts.tsx`);
    const imports = [...source.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gmu)].map((m) => m[1]);
    for (const from of imports) expect(from, from).toMatch(/^(react|\.\.?\/)/u);
    const library =
      /"(recharts|chart\.js|d3(-[a-z]+)?|victory|@nivo\/[a-z-]+|@visx\/[a-z-]+|echarts|apexcharts|highcharts|plotly\.js|vega(-lite)?)"\s*:/u;
    for (const manifest of ['package.json', 'packages/ui/package.json', 'apps/web/package.json'])
      expect(read(`${root}${manifest}`), manifest).not.toMatch(library);

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
  });

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

  it('MP-1-5 line, column and donut charts show value tooltips on hover and keyboard focus (R57), and a second quantity gets its own labelled right-hand axis (R58)', async () => {
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
  });

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
    await act(async () => {
      (active as SVGElement).blur();
    });
    expect(mounted.find('[role="tooltip"]')).toBeNull();
  });

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
        figure.getAttribute('data-state') ?? '',
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

  it.todo(
    'MP-1-5 owner check: the Executive page, every chart draws and hovering or tabbing onto a point shows its value (staging, S0-1; again in MP-14-3)',
  );
});
