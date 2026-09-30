// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-5's check that the charts are drawn by the kit alone: the chart files
// import nothing but React and each other, and no manifest names a chart
// package. Read from disk, under the chart tests' jsdom environment too.

import { readdirSync, readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import { expect } from 'vitest';

// Node's URL, not the document's: jsdom replaces the global one.
const root = fileURLToPath(new NodeURL('../..', import.meta.url));
const read = (path: string): string => readFileSync(path, 'utf8');

/** Nothing but React and the kit is imported, and no manifest names a chart package. */
export function noChartLibrary(): void {
  // Nothing but React and the kit is imported, and no manifest names a chart package.
  const kit = `${root}packages/ui/src/kit/`;
  const files = readdirSync(kit).filter((name) => /^charts?[-.]/u.test(name));
  expect(files.length).toBeGreaterThan(1);
  const source = files.map((name) => read(`${kit}${name}`)).join('\n');
  const imports = [...source.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gmu)].map((m) => m[1]);
  for (const from of imports) expect(from, from).toMatch(/^(react|\.\.?\/)/u);
  const library =
    /"(recharts|chart\.js|d3(-[a-z]+)?|victory|@nivo\/[a-z-]+|@visx\/[a-z-]+|echarts|apexcharts|highcharts|plotly\.js|vega(-lite)?)"\s*:/u;
  for (const manifest of ['package.json', 'packages/ui/package.json', 'apps/web/package.json'])
    expect(read(`${root}${manifest}`), manifest).not.toMatch(library);
}
