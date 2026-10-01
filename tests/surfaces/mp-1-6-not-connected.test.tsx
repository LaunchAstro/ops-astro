// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-6: the not-connected and unavailable treatments, the freshness marker
// as an indicator, and the pink mark kept for sample data only (R56, CS-1.4).
// One test per supporting checklist line. The visual match draws the gallery's
// treatments in a real browser at three widths in both themes
// (mp-1-6-gallery-treatments.ts); the pages the ticket names wait on their slices.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it } from 'vitest';
import { GALLERY } from '../../packages/ui/src/kit/gallery.tsx';
import {
  FreshnessMarker,
  NotConnected,
  SourceRegion,
  Unavailable,
  type Freshness,
} from '../../packages/ui/src/kit/treatments.tsx';
import { mount, type Mounted } from './mount.tsx';
import { primitiveSheets } from '../support/primitive-sheets.ts';
import type { TreatmentView } from './mp-1-6-gallery-treatments.ts';

type TreatmentsReport = { views: TreatmentView[]; sameInDark: number[] };

// Node's URL, not the document's: jsdom replaces the global one.
const root = fileURLToPath(new NodeURL('../..', import.meta.url));
const read = (path: string): string => readFileSync(path, 'utf8');
const sheet = primitiveSheets();
const html = (element: ReactElement): string => renderToStaticMarkup(element);
/** Every source file of the interface, for the checks that no page does a thing. */
const sources = (): readonly { path: string; text: string }[] => {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(tsx?|css)$/u.test(name))
        out.push({ path: path.slice(root.length), text: read(path) });
    }
  };
  walk(`${root}packages/ui/src`);
  walk(`${root}apps/web/src`);
  return out;
};
/** The declarations of every rule whose selector list mentions `needle`. */
const rulesMentioning = (needle: string): readonly string[] =>
  [...sheet.replaceAll(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{([^}]*)\}/gu)]
    .filter((m) => (m[1] ?? '').includes(needle))
    .map((m) => `${(m[1] ?? '').trim()} { ${(m[2] ?? '').trim()} }`);

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

it('MP-1-6 the hatch becomes the not connected state with its reason', () => {
  const out = html(
    <NotConnected
      source="Billing source"
      reason="No billing source is connected for this client."
    />,
  );
  expect(out).toContain('<span class="notconn__word">Not connected</span>');
  expect(out).toContain('Billing source');
  expect(out).toContain(
    '<p class="notconn__reason">No billing source is connected for this client.</p>',
  );
  // No pink, no hatch, and nothing to press to make it sync.
  expect(out).not.toContain('is-mock');
  expect(out).not.toMatch(/<button/u);
  for (const rule of rulesMentioning('.notconn')) {
    expect(rule).not.toMatch(/--mock-|repeating-linear-gradient|hatch/u);
  }
});

it('MP-1-6 an unavailable control is disabled with a tooltip naming the feature, and an unavailable primary is an outline', async () => {
  mounted = await mount(<Unavailable feature="Online payment" label="Pay now" variant="primary" />);
  const button = mounted.find('button');
  const wrapper = mounted.find('.unavail');
  expect(button?.hasAttribute('disabled')).toBe(true);
  expect(button?.className).toBe('btn btn--primary btn--sm');
  // The disabled button cannot take focus, so its wrapper does, described by the tooltip.
  expect(wrapper?.getAttribute('tabindex')).toBe('0');
  const tip = mounted.find(`#${String(wrapper?.getAttribute('aria-describedby'))}`);
  expect(tip?.getAttribute('role')).toBe('tooltip');
  expect(tip?.textContent).toBe('Online payment is not available yet');
  // DR-22, PR3: the disabled primary is an outline, not a fill.
  expect(sheet).toMatch(
    /\.btn--primary:disabled\s*\{[^}]*border-color:\s*var\(--border\);[^}]*background:\s*transparent/u,
  );
});

it('MP-1-6 the header freshness marker is an indicator only, in five states, and no page has a sync button', () => {
  const cases: readonly [Freshness, string][] = [
    [{ state: 'live', age: '2 min ago' }, 'Updated 2 min ago'],
    [{ state: 'catching-up', lastRead: '10:42' }, 'Reconnecting · last read 10:42'],
    [{ state: 'offline', lastRead: '10:42' }, 'Offline · showing data from 10:42'],
    [
      {
        state: 'source-behind',
        source: 'Search Console',
        lastGood: '26 Sep',
        href: '/connections/',
      },
      'Search Console behind · last good 26 Sep',
    ],
    [{ state: 'frozen', at: 'Saturday 6:10am' }, 'Frozen Saturday 6:10am'],
  ];
  for (const [freshness, words] of cases) {
    const out = html(<FreshnessMarker freshness={freshness} />);
    const marker =
      /<span class="fresh fresh--[a-z-]+" role="status">(.*?)<\/span><\/span>|<span class="fresh fresh--[a-z-]+" role="status">(.*?)<\/span>(<a|$)/u.exec(
        out,
      );
    expect(out, freshness.state).toContain(words);
    // The marker itself holds no control and takes no focus.
    expect(marker?.[0] ?? '', freshness.state).not.toMatch(/<button|<a |tabindex/u);
  }
  expect(html(<FreshnessMarker freshness={cases[3]![0]} />)).toContain('href="/connections/"');
  // No hover, focus or press look anywhere on the marker.
  expect(rulesMentioning('.fresh').filter((r) => /:(hover|focus|active)/u.test(r))).toEqual([]);
  // No page draws a sync control. (The task page's Refresh re-reads after a
  // conflict; whether live updates replace it is the live page kit's to decide.)
  // One named exception: MP-14-7 keeps a connector's Sync now as a fallback on
  // a stuck source only, shown unavailable until connectors exist. That exact
  // form, gated on isStuck, is taken out before the check; any other is caught.
  const stuckFallback =
    /isStuck\(row, props\.now\) \? <Unavailable action="sync" label="Sync now" \/> : null/u;
  const offenders = sources()
    .map(({ path, text }) => ({
      path,
      text: path.endsWith('screens/connections/fleet-row.tsx')
        ? text.replace(stuckFallback, '')
        : text,
    }))
    .filter(
      ({ text }) =>
        />\s*(Sync|Sync now|Resync)\s*</u.test(text) ||
        /(label|aria-label|busy)="(Sync|Resync)[^"]*"/u.test(text),
    );
  expect(offenders.map((o) => o.path)).toEqual([]);
});

it('MP-1-6 mock data keeps the low-opacity pink on a demo install, and a real client shows none', () => {
  expect(html(<SourceRegion provenance="mock">31</SourceRegion>)).toContain('class="is-mock"');
  expect(html(<SourceRegion provenance="real">31</SourceRegion>)).toBe('31');
  expect(html(<SourceRegion provenance="absent">No data</SourceRegion>)).toBe('No data');
  // The pink is a wash: low opacity, and an inset edge that never moves layout.
  const tokens = read(`${root}packages/ui/src/styles/1-tokens.css`);
  expect(tokens).toMatch(
    /--mock-tint: color-mix\(in oklab, var\(--mock-pink\) 9%, transparent\);/u,
  );
});

it('MP-1-6 CS-1.4 on a real client no pink ever shows', () => {
  // The pink tokens are painted by the mock mark's rules and nothing else.
  const painted = [
    ...sheet.replaceAll(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{([^}]*--mock-[^}]*)\}/gu),
  ].map((m) => (m[1] ?? '').trim());
  expect(painted.length).toBeGreaterThan(0);
  for (const selector of painted) expect(selector).toMatch(/^\.is-mock/u);
  // The mark is applied by one component, reached only through a provenance of `mock`.
  const applies = sources()
    .filter(({ text }) => /['"`]is-mock/u.test(text))
    .map((s) => s.path);
  expect(applies).toEqual(['packages/ui/src/kit/blocks.tsx']);
  const users = sources()
    .filter(({ path, text }) => /<MockRegion\b/u.test(text) && !path.endsWith('blocks.tsx'))
    .map((s) => s.path)
    .toSorted();
  expect(users).toEqual([
    'packages/ui/src/kit/gallery-feedback.tsx',
    'packages/ui/src/kit/treatments.tsx',
  ]);
});

it('MP-1-6 shown in its own unit on the component gallery', () => {
  const entry = GALLERY.find((e) => (e.id as string) === 'MP-1-6');
  expect(entry?.states.map((s) => s.label)).toEqual([
    'Not connected',
    'Unavailable control',
    'Unavailable primary',
    'Live',
    'Catching up',
    'Offline',
    'Source behind',
    'Frozen',
    'Sample data, demo install only',
    'Real data, never marked',
  ]);
});

it('MP-1-6 visual match: the treatments on the gallery at 1480, 900 and 390, light and dark, in a browser: not connected with its reason, the outline primary with its tooltip, the freshness marker an indicator, pink on sample data only', () => {
  const script = new NodeURL('mp-1-6-gallery-treatments.ts', import.meta.url).pathname;
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 900_000 });
  expect(run.status, run.stderr.slice(-2000)).toBe(0);
  const { views, sameInDark } = JSON.parse(run.stdout) as TreatmentsReport;
  expect(views).toHaveLength(6);
  for (const view of views) {
    const width = Number(/@(\d+)-/u.exec(view.name)?.[1]);
    expect(view.sideways, `${view.name} scrolls sideways`).toBe(0);
    expect(view.unit.left, view.name).toBeGreaterThanOrEqual(0);
    expect(view.unit.right, view.name).toBeLessThanOrEqual(width);
    expect(view.notConnected, view.name).toEqual({ word: true, reason: true, hatch: 'none' });
    expect(view.primary, view.name).toEqual({
      disabled: true,
      background: 'rgba(0, 0, 0, 0)',
      border: '1px',
      tip: 'Online payment is not available yet',
    });
    expect(view.markers, view.name).toEqual({ count: 5, buttons: 0, hoverDraws: [] });
    expect(view.pink, view.name).toEqual(['Sample data, demo install only']);
  }
  expect(sameInDark, 'widths where the unit draws the same in dark').toEqual([]);
}, 900_000);

it.todo(
  'MP-1-6 on the pages: /clients/:client/account/ and an unconnected workbench tab at 1480, 900 and 390, light and dark (MP-1-7 harness; waits on those pages, MP-12-7 and the workbench slices)',
);
