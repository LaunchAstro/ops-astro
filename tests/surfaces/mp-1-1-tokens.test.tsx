// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-1: the token file at mockup parity, and the dark theme.
//
// The token sets are read through `scripts/token-diff.mjs`, the same resolver
// the diff runs, so the tests and the script cannot disagree about what a token
// resolves to. The harness captures run here in a real browser, on MP-1-7's
// width-and-theme harness; the other visual legs are in mp-1-1-harness.test.tsx.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { Shell } from '../../packages/ui/src/surfaces/Shell.tsx';
import { dockOf } from './dock-props.ts';
import { captureBuiltPages, madeUpSession, serveApp } from '../visual/app-pages.ts';
import { comparePng } from '../visual/compare.ts';
import { fetchAssets, MODE, readAssets, readPacket, themesOf } from '../visual/packet.ts';
import { builtPages, report } from '../visual/report.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const script = `${root}scripts/token-diff.mjs`;
const styles = `${root}packages/ui/src/styles/`;
const tokensCss = `${styles}1-tokens.css`;
const read = (path: string): string => readFileSync(path, 'utf8');

interface Expected {
  readonly groups: Readonly<Record<string, readonly string[]>>;
  readonly light: Readonly<Record<string, string>>;
  readonly dark: Readonly<Record<string, string>>;
}
type Sets = Readonly<Record<'light' | 'dark', Readonly<Record<string, string>>>>;

const expected = JSON.parse(read(`${root}tests/surfaces/fixtures/mp-1-1-tokens.json`)) as Expected;
const baseline = JSON.parse(read(`${root}tests/surfaces/fixtures/mp-1-1-light-baseline.json`)) as {
  readonly light: Readonly<Record<string, string>>;
};

const run = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const out = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
};
const resolved = (): Sets => JSON.parse(run('--print').stdout) as Sets;

const scratch = mkdtempSync(join(tmpdir(), 'mp-1-1-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Every token the product declares that is not colour, spacing, radius, shadow or motion (icon sizes from MP-1-2, the type scale from MP-1-4). */
const OTHER_GROUPS =
  /^--(font-|icon-|text-(h\d|body|body-lg|sm|label|overline|display|micro|num-(lg|md|sm))$|type-|fs-|leading-|lh-|tracking-|weight-|rail-w$|dock-w$|aip-dock$|content-floor$|scheme$)/u;
/** Kept legacy names the canonical set maps onto another token (buttons, radius, brand). */
const ALIASES = new Set([
  '--brand',
  '--accent-ink',
  '--void-deep',
  '--btn-fill',
  '--btn-text',
  '--btn-hover',
  '--btn-hover-text',
  '--btn-outline',
  '--radius-xs',
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
]);
const STATUS_ALIASES = /^--(info|success|warning|danger)-(light|soft)$/u;

// Held on purpose in both themes: the one accent, ink on a dark or accent
// ground, the dark ground itself, and the fills that do not flip. The two
// lilacs are chart paint (the mockup's PAINT): its sheets never flip them.
const CONSTANT = new Set([
  '--accent',
  '--lilac',
  '--lilac-deep',
  '--accent-ink',
  '--brand',
  '--btn-hover',
  '--btn-hover-text',
  '--on-dark',
  '--on-dark-muted',
  '--void',
  '--client-brand',
  '--hero-paint',
  '--scrim',
  '--accent-wash',
  '--shadow-overlay',
  '--info-light',
  '--success-light',
  '--warning-light',
  '--danger-light',
]);
const COLOUR_PROPERTY =
  /^(color|background(-color|-image)?|border(-(top|right|bottom|left|block|inline)(-start|-end)?)?(-color)?|outline(-color)?|box-shadow|fill|stroke|caret-color|accent-color|text-decoration(-color)?|column-rule(-color)?)$/u;
const SHEETS = [
  `${styles}2-controls-and-marks.css`,
  `${styles}2-primitives.css`,
  `${styles}3-shell.css`,
  `${styles}4-board.css`,
  `${styles}5-task.css`,
  `${root}apps/web/src/styles/6-slice.css`,
];
const lightOnly = (sets: Sets, name: string, css: string): string[] => {
  const problems: string[] = [];
  const bare = css.replaceAll(/\/\*[\s\S]*?\*\//gu, '');
  for (const match of bare.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/gu)) {
    const [, property = '', value = ''] = match;
    if (!COLOUR_PROPERTY.test(property)) continue;
    const where = `${name} ${property}: ${value.trim()}`;
    if (/#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|oklch|oklab|lab|lch)\(|\b(white|black)\b/iu.test(value)) {
      problems.push(`literal colour in ${where}`);
    }
    for (const [, token = ''] of value.matchAll(/var\((--[\w-]+)/gu)) {
      if (sets.light[token] === undefined) problems.push(`undeclared ${token} in ${where}`);
      else if (sets.light[token] === sets.dark[token] && !CONSTANT.has(token)) {
        problems.push(`${token} has no dark value, in ${where}`);
      }
    }
  }
  return problems;
};

describe('MP-1-1 tokens', () => {
  it('MP-1-1 every token paired', () => {
    const sets = resolved();
    for (const [group, names] of Object.entries(expected.groups)) {
      for (const name of names) {
        expect(sets.light[name], `${group} ${name} in light`).toBeTypeOf('string');
        expect(sets.dark[name], `${group} ${name} in dark`).toBeTypeOf('string');
        expect(sets.light[name], `${name} light resolves fully`).not.toContain('var(');
        expect(sets.dark[name], `${name} dark resolves fully`).not.toContain('var(');
      }
    }
    // Nothing in these five groups exists outside the expected set.
    const listed = new Set(Object.values(expected.groups).flat());
    const unlisted = Object.keys(sets.light).filter(
      (name) =>
        !listed.has(name) &&
        !OTHER_GROUPS.test(name) &&
        !ALIASES.has(name) &&
        !STATUS_ALIASES.test(name),
    );
    expect(unlisted).toEqual([]);

    // Nothing is declared in dark alone: every dark token has a light value.
    expect(Object.keys(sets.dark).filter((name) => sets.light[name] === undefined)).toEqual([]);
    const darkOnly = read(tokensCss).replace(
      "[data-theme='dark'] {",
      "[data-theme='dark'] {\n  --unpaired: oklch(0.9 0 0);",
    );
    const path = join(scratch, 'dark-only.css');
    writeFileSync(path, darkOnly);
    const planted = JSON.parse(run('--print', '--css', path).stdout) as Sets;
    expect(planted.dark['--unpaired']).toBe('oklch(0.9 0 0)');
    expect(planted.light['--unpaired']).toBeUndefined();
    const bitten = run('--css', path);
    expect(bitten.status).toBe(1);
    expect(bitten.stderr).toContain('dark --unpaired: declared in dark only');
  });
});

describe('MP-1-1 tokens', () => {
  it('MP-1-1 token diff', () => {
    const clean = run();
    expect(clean.stderr).toBe('');
    expect(clean.status).toBe(0);

    // A planted drift: one dark colour changed. The diff fails and names it.
    const drifted = read(tokensCss).replace(
      /(\[data-theme='dark'\] \{[\s\S]*?--surface-2: )[^;]+;/u,
      '$1oklch(0.3 0 0);',
    );
    expect(drifted).not.toBe(read(tokensCss));
    const path = join(scratch, 'drift.css');
    writeFileSync(path, drifted);
    const bitten = run('--css', path);
    expect(bitten.status).toBe(1);
    expect(bitten.stderr).toContain('dark --surface-2');
    expect(bitten.stderr.trim().split('\n')).toHaveLength(1);

    // Lookalikes ahead of the real blocks are not read: a commented-out block,
    // and rules whose selectors only start with or contain the real one.
    const lookalikes = [
      "/* [data-theme='dark'] { --surface-2: oklch(0.1 0 0); } :root { --bg: #000; } */",
      ":root:not([data-theme='light']) .x { --bg: oklch(0.1 0 0); }",
      "[data-theme='dark'] .card { --surface-2: oklch(0.2 0 0); }",
      '',
    ].join('\n');
    const tricked = join(scratch, 'lookalikes.css');
    writeFileSync(tricked, lookalikes + read(tokensCss));
    expect(run('--css', tricked)).toMatchObject({ status: 0, stderr: '' });
    expect(JSON.parse(run('--print', '--css', tricked).stdout)).toEqual(resolved());
  });
});

describe('MP-1-1 tokens', () => {
  it('MP-1-1 light unchanged', () => {
    // Token level. The 1480, 900 and 390 captures are MP-1-7's harness.
    const sets = resolved();
    for (const [name, value] of Object.entries(baseline.light)) {
      expect(sets.light[name], name).toBe(value);
    }
  });
});

describe('MP-1-1 tokens', () => {
  it('MP-1-1 no light-only element', () => {
    const sets = resolved();
    // It bites: a literal, a token that never flips and an undeclared one.
    expect(
      lightOnly(
        sets,
        'planted',
        '.x { background: #fff; color: var(--void-deep); border-color: var(--nope); }',
      ),
    ).toHaveLength(3);
    expect(
      SHEETS.flatMap((sheet) => lightOnly(sets, sheet.slice(root.length), read(sheet))),
    ).toEqual([]);
  });
});

describe('MP-1-1 tokens', () => {
  it('MP-1-1 dock callout edge', () => {
    const sets = resolved();
    const shell = read(`${styles}3-shell.css`).replaceAll(/\/\*[\s\S]*?\*\//gu, '');
    const rule = /\.dock__tablabel\s*\{([^}]*)\}/u.exec(shell)?.[1] ?? '';
    const ground = /background:\s*var\((--[\w-]+)\)/u.exec(rule)?.[1] ?? '';
    const edge = /border:\s*1px solid var\((--[\w-]+)\)/u.exec(rule)?.[1] ?? '';
    expect(ground, 'the callout has a token ground').not.toBe('');
    expect(edge, 'the callout has a 1px token edge').not.toBe('');
    const dark = sets.dark;
    expect(dark[edge], 'the edge differs from the callout ground in dark').not.toBe(dark[ground]);
    expect(dark[edge], 'the edge differs from the page ground in dark').not.toBe(dark['--bg']);
    expect(dark[edge]).not.toBe('transparent');

    // Every dock tab carries its callout, hidden from the accessible name.
    const html = renderToStaticMarkup(
      <Shell
        face="agency"
        rail={[]}
        here="/"
        title="Board"
        dock={dockOf([
          { id: 'assistant', label: 'Assistant', open: false },
          { id: 'clients', label: 'Clients', open: true },
        ])}
      >
        <p>content</p>
      </Shell>,
    );
    expect(html).toContain('<span class="dock__tablabel" aria-hidden="true">Assistant</span>');
    expect(html).toContain('<span class="dock__tablabel" aria-hidden="true">Clients</span>');
  });
});

describe('MP-1-1 on the width-and-theme harness (MP-1-7)', () => {
  it('MP-1-1 harness captures: every built page in light and dark at 1480, 900 and 390', async () => {
    const packet = readPacket();
    // Dark is captured from here, where the dark theme lands; no longer pending.
    expect(packet.themes.dark).toBe('captured');
    const widths = [1480, 900, 390];
    await fetchAssets(readAssets(), packet);
    // No browser, no capture: the launch fails the test, never skips it.
    const browser = await chromium.launch(MODE);
    const { app, close } = await serveApp();
    try {
      const out = join(scratch, 'captures');
      const session = madeUpSession(app, out);
      const themes = themesOf(packet);
      const shots = await captureBuiltPages({ browser, packet, app, session, widths, themes, out });
      // The report reads each picture file the browser wrote: a PNG as wide as its width.
      const all = report({ ...packet, widths }, builtPages(), shots);
      expect(all.failed).toBe(0);
      // Each dark picture is drawn in dark: it differs from its light one.
      const file = (page: string, width: number, theme: string): Buffer =>
        readFileSync(join(out, `${page}@${width}-${theme}.page.png`));
      for (const page of builtPages())
        for (const width of widths) {
          expect(all.lines).toContain(
            `ok ${page}@${width}-dark: ${page}@${width}-dark.page.png; no sideways scroll`,
          );
          const name = `${page}@${width}`;
          const same = comparePng(name, file(page, width, 'light'), file(page, width, 'dark'));
          expect(same.pass, `${name} dark draws the same as light`).toBe(false);
        }
    } finally {
      await browser.close();
      await close();
    }
  }, 600_000);
});
