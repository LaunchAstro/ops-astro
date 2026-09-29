// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-1: the token file at mockup parity, and the dark theme.
//
// The token sets are read through `scripts/token-diff.mjs`, the same resolver
// the diff runs, so the tests and the script cannot disagree about what a token
// resolves to. The visual legs run on MP-1-7's width-and-theme harness
// (`tests/visual`), which captures dark from here, where the dark theme lands:
// these tests hold the harness's dark report and planted drift in the required
// checks, and `node tests/visual/run.ts --prove-drift` runs the same drift in
// the pinned renderer against the pinned mockup. The /dashboard/ match waits
// on the page (MP-14-1) and T4b1's signed-in fixture; the harness serves the
// mockup by file path, so its canonical addresses need the mockup's route
// manifest when that page lands.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { Shell } from '../../packages/ui/src/surfaces/Shell.tsx';
import { contextOptions, type Catalogue } from '../visual/capture.ts';
import { comparePng } from '../visual/compare.ts';
import { readPacket, themesOf } from '../visual/packet.ts';
import { builtPages, report, type PageShot } from '../visual/report.ts';

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

  it('MP-1-1 light unchanged', () => {
    // Token level. The 1480, 900 and 390 captures are MP-1-7's harness.
    const sets = resolved();
    for (const [name, value] of Object.entries(baseline.light)) {
      expect(sets.light[name], name).toBe(value);
    }
  });

  it('MP-1-1 no light-only element', () => {
    const sets = resolved();
    // Held on purpose in both themes: the one accent, ink on a dark or accent
    // ground, the dark ground itself, and the fills that do not flip.
    const constant = new Set([
      '--accent',
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
    const colourProperty =
      /^(color|background(-color|-image)?|border(-(top|right|bottom|left|block|inline)(-start|-end)?)?(-color)?|outline(-color)?|box-shadow|fill|stroke|caret-color|accent-color|text-decoration(-color)?|column-rule(-color)?)$/u;
    const sheets = [
      `${styles}2-controls-and-marks.css`,
      `${styles}2-primitives.css`,
      `${styles}3-shell.css`,
      `${styles}4-board.css`,
      `${styles}5-task.css`,
      `${root}apps/web/src/styles/6-slice.css`,
    ];
    const lightOnly = (name: string, css: string): string[] => {
      const problems: string[] = [];
      const bare = css.replaceAll(/\/\*[\s\S]*?\*\//gu, '');
      for (const match of bare.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/gu)) {
        const [, property = '', value = ''] = match;
        if (!colourProperty.test(property)) continue;
        const where = `${name} ${property}: ${value.trim()}`;
        if (
          /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|oklch|oklab|lab|lch)\(|\b(white|black)\b/iu.test(value)
        ) {
          problems.push(`literal colour in ${where}`);
        }
        for (const [, token = ''] of value.matchAll(/var\((--[\w-]+)/gu)) {
          if (sets.light[token] === undefined) problems.push(`undeclared ${token} in ${where}`);
          else if (sets.light[token] === sets.dark[token] && !constant.has(token)) {
            problems.push(`${token} has no dark value, in ${where}`);
          }
        }
      }
      return problems;
    };
    // It bites: a literal, a token that never flips and an undeclared one.
    expect(
      lightOnly(
        'planted',
        '.x { background: #fff; color: var(--void-deep); border-color: var(--nope); }',
      ),
    ).toHaveLength(3);
    expect(sheets.flatMap((sheet) => lightOnly(sheet.slice(root.length), read(sheet)))).toEqual([]);
  });

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
        dock={[
          { id: 'assistant', label: 'Assistant', open: false },
          { id: 'clients', label: 'Clients', open: true },
        ]}
        onDockTab={() => {}}
        seated={false}
      >
        <p>content</p>
      </Shell>,
    );
    expect(html).toContain('<span class="dock__tablabel" aria-hidden="true">Assistant</span>');
    expect(html).toContain('<span class="dock__tablabel" aria-hidden="true">Clients</span>');
  });
});

type Rgb = readonly [number, number, number];

/** A linear-light channel as an sRGB byte. */
const encode = (x: number): number =>
  Math.round(
    255 * Math.min(1, Math.max(0, x <= 0.003_130_8 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)),
  );

/** A resolved colour token as sRGB bytes: `#rrggbb` or `oklch(L C H)`. */
function rgbOf(value: string | undefined): Rgb {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(value ?? '');
  if (hex !== null) return [1, 2, 3].map((i) => Number.parseInt(hex[i] ?? '', 16)) as never;
  const lch = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/u.exec(value ?? '');
  if (lch === null) throw new Error(`not a plain colour: ${String(value)}`);
  const [l, c, h] = [Number(lch[1]), Number(lch[2]), (Number(lch[3]) * Math.PI) / 180];
  const [a, b] = [c * Math.cos(h), c * Math.sin(h)];
  const lms = [
    (l + 0.396_337_777_4 * a + 0.215_803_757_3 * b) ** 3,
    (l - 0.105_561_345_8 * a - 0.063_854_172_8 * b) ** 3,
    (l - 0.089_484_177_5 * a - 1.291_485_548 * b) ** 3,
  ] as const;
  const linear = [
    4.076_741_662_1 * lms[0] - 3.307_711_591_3 * lms[1] + 0.230_969_929_2 * lms[2],
    -1.268_438_004_6 * lms[0] + 2.609_757_401_1 * lms[1] - 0.341_319_396_5 * lms[2],
    -0.004_196_086_3 * lms[0] - 0.703_418_614_7 * lms[1] + 1.707_614_701 * lms[2],
  ];
  return linear.map(encode) as never;
}

/** A capture as wide as the viewport on the theme's ground, one control drawn in a token colour. */
function capture(width: number, ground: Rgb, control: { x: number; colour: Rgb }): Buffer {
  const height = 80;
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = x >= control.x && x < control.x + 60 && y >= 20 && y < 50;
      const [r, g, b] = inside ? control.colour : ground;
      const i = (y * width + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

const catalogue = (): Catalogue => JSON.parse(read(`${root}tests/visual/states.json`)) as Catalogue;

describe('MP-1-1 on the width-and-theme harness (MP-1-7)', () => {
  it('MP-1-1 harness captures: every built page in light and dark at 1480, 900 and 390', () => {
    const packet = readPacket();
    // Dark is captured from here, where the dark theme lands; no longer pending.
    expect(packet.themes.dark).toBe('captured');
    expect(themesOf(packet)).toEqual(['light', 'dark']);
    for (const width of [1480, 900, 390]) expect(packet.widths).toContain(width);

    // The browser draws each side in the theme it captures.
    expect(contextOptions(packet, 390, 'dark')).toMatchObject({
      colorScheme: 'dark',
      viewport: { width: 390, height: packet.height },
    });
    expect(contextOptions(packet, 1480, 'light')).toMatchObject({ colorScheme: 'light' });

    // Every built page has a light and a dark picture file at every width,
    // each a PNG as wide as that width; the report reads the files.
    const sets = resolved();
    const ground = { light: rgbOf(sets.light['--bg']), dark: rgbOf(sets.dark['--bg']) };
    const shots: PageShot[] = builtPages().flatMap((page) =>
      packet.widths.flatMap((width) =>
        themesOf(packet).map((theme) => {
          const picture = join(scratch, `${page}@${width}-${theme}.page.png`);
          writeFileSync(picture, capture(width, ground[theme], { x: 40, colour: ground[theme] }));
          return { page, width, theme, picture, overflow: 0 };
        }),
      ),
    );
    const all = report(packet, builtPages(), shots);
    expect(all.failed).toBe(0);
    expect(all.lines.filter((line) => line.startsWith('pending'))).toEqual([]);
    for (const page of builtPages())
      for (const width of [1480, 900, 390])
        expect(all.lines).toContain(
          `ok ${page}@${width}-dark: ${page}@${width}-dark.page.png; no sideways scroll`,
        );

    // A dark picture whose file is gone, one taken at another width, a file
    // that is not an image, and a dark page that scrolls sideways each fail by name.
    const at = (page: string, width: number): PageShot => {
      const shot = shots.find((s) => s.page === page && s.width === width && s.theme === 'dark');
      if (shot === undefined) throw new Error(`no ${page}@${width}-dark shot`);
      return shot;
    };
    rmSync(at('agency:sign-in', 390).picture ?? '');
    const narrow = at('agency:settings', 1480).picture ?? '';
    writeFileSync(narrow, capture(390, ground.dark, { x: 40, colour: ground.dark }));
    writeFileSync(at('agency:projects-board', 390).picture ?? '', 'no image here');
    at('agency:gallery', 900).overflow = 8;
    const bad = report(packet, builtPages(), shots);
    expect(bad.failed).toBe(4);
    expect(bad.lines).toContain('FAIL agency:projects-board@390-dark: picture is not a PNG');
    expect(bad.lines).toContain('FAIL agency:sign-in@390-dark: no picture');
    expect(bad.lines).toContain('FAIL agency:settings@1480-dark: picture is 390 px wide, not 1480');
    expect(bad.lines).toContain('FAIL agency:gallery@900-dark: scrolls sideways by 8 px');
  });

  it('MP-1-1 dark harness bites: a two-pixel shift or one dark colour fails the dark capture, naming it', () => {
    const packet = readPacket();
    expect(themesOf(packet)).toContain('dark');
    const { state, token } = catalogue().drift;
    const sets = resolved();
    // The dark capture is not the light one (product issue 62): its ground and
    // the drift token both take their dark values.
    expect(sets.dark['--bg']).not.toBe(sets.light['--bg']);
    expect(sets.dark[token]).not.toBe(sets.light[token]);
    const ground = rgbOf(sets.dark['--bg']);
    const colour = rgbOf(sets.dark[token]);
    // One dark colour moved a little towards black, as the harness's drift does.
    const changed = colour.map((c) => Math.round(c * 0.96)) as unknown as Rgb;
    for (const width of packet.widths) {
      const name = `${state}@${width}-dark#gatebox`;
      const base = capture(width, ground, { x: 40, colour });
      expect(comparePng(name, base, capture(width, ground, { x: 40, colour })).pass).toBe(true);
      const shifted = comparePng(name, base, capture(width, ground, { x: 42, colour }));
      expect(shifted).toMatchObject({ capture: name, pass: false });
      expect(shifted.line).toContain(name);
      const recoloured = comparePng(name, base, capture(width, ground, { x: 40, colour: changed }));
      expect(recoloured).toMatchObject({ capture: name, pass: false });
      expect(recoloured.line).toContain(name);
    }
  });

  it.todo(
    "MP-1-1 visual match: /dashboard/ against the mockup at 1480, 900 and 390, light and dark (MP-1-7 harness; waits on the Dashboard page, MP-14-1 in U50, and T4b1's signed-in fixture)",
  );
});
