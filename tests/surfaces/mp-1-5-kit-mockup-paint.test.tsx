// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-5: the kit's charts in the mockup's paint (DS-COMP-28, DS-COMP-29).
// The mockup's own charts.js draws the score dial's number at weight 500, the
// donut's slices in its chart paint order (ink, accent, lilac, lilac deep,
// ink muted, ink faint: PAINT in the mockup's data), and a sparkline in the
// colour of its host, which is the accent in three of its four hosts. The
// browser half reads the drawn gallery at 1480, 900 and 390 in both themes
// (mp-1-5-kit-paint.ts); the markup half pins the order past three slices.

import { spawnSync } from 'node:child_process';
import { URL as NodeURL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { DonutChart, Sparkline } from '../../packages/ui/src/kit/charts.tsx';
import type { PaintView } from './mp-1-5-kit-paint.ts';

// The mockup's values, as the browser computes them (tokens: ink, accent, lilac).
const INK = { light: 'oklch(0 0 0)', dark: 'oklch(0.98 0 0)' } as const;
const ACCENT = 'oklch(0.58 0.21 285)';
const LILAC = 'oklch(0.78 0.088 305)';

// A colour by value: the browser may give the accent as oklch or, read after a
// transition, as the same colour in oklab. Both become oklab to four places.
const oklab = (colour: string): string => {
  const match = /^okl(ab|ch)\((\S+) (\S+) (\S+)\)$/u.exec(colour);
  if (match === null) return colour;
  const [l, x, y] = match.slice(2).map(Number) as [number, number, number];
  const hue = (y * Math.PI) / 180;
  const lab = match[1] === 'ch' ? [l, x * Math.cos(hue), x * Math.sin(hue)] : [l, x, y];
  return lab.map((n) => n.toFixed(4)).join(' ');
};

let views: PaintView[] = [];

beforeAll(() => {
  const script = new NodeURL('mp-1-5-kit-paint.ts', import.meta.url).pathname;
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 900_000 });
  expect(run.status, run.stderr.slice(-2000)).toBe(0);
  views = JSON.parse(run.stdout) as PaintView[];
  expect(views).toHaveLength(6);
}, 900_000);

const themeOf = (view: PaintView): 'light' | 'dark' =>
  view.name.endsWith('-dark') ? 'dark' : 'light';

describe('MP-1-5 kit paint from the mockup', () => {
  it("MP-1-5 the score dial's number is drawn at the mockup's weight, 500, in every band", () => {
    for (const view of views) expect(view.dialWeights, view.name).toEqual(['500', '500', '500']);
  });

  it("MP-1-5 the donut's slices take the mockup's chart paint in order: ink, accent, lilac", () => {
    for (const view of views) {
      expect(view.slices, view.name).toEqual([
        { fill: INK[themeOf(view)], opacity: '0.92' },
        { fill: ACCENT, opacity: '0.92' },
        { fill: LILAC, opacity: '0.92' },
      ]);
    }
    const slices = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((label) => ({ label, value: 1 }));
    const markup = renderToStaticMarkup(
      <DonutChart name="Seven" centre="7" centreLabel="Slices" slices={slices} />,
    );
    expect([...markup.matchAll(/data-paint="([a-z]+)"/gu)].map((m) => m[1])).toEqual([
      'ink',
      'accent',
      'lilac',
      'deep',
      'muted',
      'faint',
      'ink',
    ]);
    const toned = renderToStaticMarkup(
      <DonutChart
        name="Toned"
        centre="2"
        centreLabel="Slices"
        slices={[
          { label: 'Good', value: 1, tone: 'ok' },
          { label: 'Rest', value: 1 },
        ]}
      />,
    );
    expect(toned).toContain('data-tone="ok"');
    expect(toned).toContain('data-paint="accent"');
  });

  it('MP-1-5 the sparkline draws in the accent, its host colour in the mockup, and keeps a named tone', () => {
    for (const { name, spark } of views)
      for (const colour of [spark.line, spark.area, spark.end])
        expect(oklab(colour), name).toBe(oklab(ACCENT));
    const inked = renderToStaticMarkup(<Sparkline name="Uptime" values={[1, 2]} tone="ink" />);
    expect(inked).toContain('data-tone="ink"');
  });
});
