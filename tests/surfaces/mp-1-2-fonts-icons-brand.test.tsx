// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-2: fonts, the icon set and the brand marks.
//
// One test per supporting checklist line. The fonts and the icon set arrive as
// pinned packages, so no font or icon binary sits in the tree; the brand marks
// are the rights holder's own SVGs. Every bundled asset is named, with its
// licence, in `packages/ui/assets/licences.json`, and these tests hold that
// record against what is actually installed and committed, both ways. The
// visual match runs on MP-1-7's width-and-theme harness over the gallery, which
// asks for a session, so it is `todo` until T4b1's signed-in fixture.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadConfigFromFile } from 'vite';
import { afterAll, expect, it } from 'vitest';
import { BrandMark } from '../../packages/ui/src/primitives/BrandMark.tsx';
import { GLYPH_NAMES, Icon } from '../../packages/ui/src/primitives/Icon.tsx';
import { Shell } from '../../packages/ui/src/surfaces/Shell.tsx';

const root = fileURLToPath(new URL('../..', import.meta.url));
const ui = `${root}packages/ui/`;
const read = (path: string): string => readFileSync(path, 'utf8');
const json = <T,>(path: string): T => JSON.parse(read(path)) as T;

interface AssetRecord {
  readonly id: string;
  readonly kind: 'font' | 'icon-set' | 'brand-mark';
  readonly licence: string;
  readonly licenceFile: string;
  readonly package?: string;
  readonly version?: string;
  readonly path?: string;
  readonly source: string;
}
const record = (): readonly AssetRecord[] =>
  json<{ assets: readonly AssetRecord[] }>(`${ui}assets/licences.json`).assets;
const uiDependencies = (): Readonly<Record<string, string>> =>
  json<{ dependencies?: Record<string, string> }>(`${ui}package.json`).dependencies ?? {};

/** The three families and the weights TOKENS.md DS-TOK-28 to DS-TOK-30 name. */
const FONTS = [
  {
    pkg: '@fontsource/funnel-display',
    family: 'Funnel Display',
    token: '--font-display',
    weights: [400, 500, 600, 700],
  },
  {
    pkg: '@fontsource/funnel-sans',
    family: 'Funnel Sans',
    token: '--font-sans',
    weights: [400, 500, 600],
  },
  {
    pkg: '@fontsource/chivo-mono',
    family: 'Chivo Mono',
    token: '--font-mono',
    weights: [300, 400, 500],
  },
] as const;
const fontsCss = `${ui}src/styles/0-fonts.css`;

const scratch = mkdtempSync(join(tmpdir(), 'mp-1-2-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Run the real licence checker over a report, as CI runs it over pnpm's. */
const licences = (report: unknown): { status: number | null; out: string } => {
  const file = join(scratch, `report-${String(Math.random()).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(report));
  const run = spawnSync(process.execPath, [`${root}scripts/licences/check.mjs`, '--report', file], {
    encoding: 'utf8',
  });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
};
const ofl = (name: string, licence = 'OFL-1.1'): unknown => ({
  MIT: [{ name: 'left-pad', version: '1.0.0' }],
  [licence]: [{ name, version: '5.3.0' }],
});

it('MP-1-2 fonts load from the three OFL fonts', () => {
  const deps = uiDependencies();
  const tokens = read(`${ui}src/styles/1-tokens.css`);
  const index = read(`${ui}src/index.ts`);
  expect(existsSync(fontsCss), 'packages/ui/src/styles/0-fonts.css').toBe(true);
  const sheet = read(fontsCss);
  const imports = [...sheet.matchAll(/@import\s+'([^']+)'/gu)].map((m) => m[1]);
  const wanted = FONTS.flatMap((f) => f.weights.map((w) => `${f.pkg}/latin-${w}.css`));
  // Exactly the weights the tokens use: no italics, no whole-family index.
  expect(imports).toEqual(wanted);
  for (const font of FONTS) {
    expect(deps[font.pkg], `${font.pkg} is a pinned dependency`).toMatch(/^\d+\.\d+\.\d+$/u);
    // The token's first family is the face the package declares.
    expect(tokens).toMatch(new RegExp(`${font.token}:\\s*'${font.family}',`, 'u'));
    for (const weight of font.weights) {
      const face = read(`${ui}node_modules/${font.pkg}/latin-${weight}.css`);
      expect(face).toContain(`font-family: '${font.family}'`);
      expect(face).toContain(`font-weight: ${weight}`);
    }
  }
  // The fonts sheet loads first, so the tokens name faces that exist.
  expect(index.indexOf("'./styles/0-fonts.css'")).toBeGreaterThan(-1);
  expect(index.indexOf("'./styles/0-fonts.css'")).toBeLessThan(
    index.indexOf("'./styles/1-tokens.css'"),
  );
});

it('MP-1-2 each font ships with its licence file', async () => {
  const fonts = record().filter((a) => a.kind === 'font');
  expect(fonts.map((a) => a.package).toSorted()).toEqual(FONTS.map((f) => f.pkg).toSorted());
  for (const font of fonts) {
    const shipped = read(`${ui}assets/${font.licenceFile}`);
    expect(shipped).toContain('SIL Open Font License, Version 1.1');
    // The committed text is the installed package's own, byte for byte.
    expect(shipped).toBe(read(`${ui}node_modules/${String(font.package)}/LICENSE`));
  }
  // The web build copies the record and the licence texts into its output:
  // the web app's config, resolved by vite itself.
  const web = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    fileURLToPath(new URL('../../apps/web/vite.config.ts', import.meta.url)),
  );
  expect(web?.config.publicDir).toBe(
    fileURLToPath(new URL('../../packages/ui/assets', import.meta.url)),
  );
});

it('MP-1-2 icons from an open-licence set drawn to match', () => {
  const mockup = json<{ glyphs: readonly string[] }>(
    `${root}tests/surfaces/fixtures/mp-1-2-mockup-glyphs.json`,
  );
  expect(mockup.glyphs.length).toBeGreaterThan(60);
  // Every glyph the mockup draws has a replacement, and no other name exists.
  expect([...GLYPH_NAMES].toSorted()).toEqual([...mockup.glyphs].toSorted());
  for (const name of GLYPH_NAMES) {
    const html = renderToStaticMarkup(<Icon name={name} />);
    expect(html, name).toMatch(/^<svg[^>]*\bclass="[^"]*\bicon icon--md"/u);
    expect(html, name).toContain('stroke-linecap="round"');
    expect(html, name).toContain('aria-hidden="true"');
  }
  const named = renderToStaticMarkup(<Icon name="bell" label="Notifications" size="lg" />);
  expect(named).toContain('role="img"');
  expect(named).toContain('aria-label="Notifications"');
  expect(named).not.toContain('aria-hidden');
  expect(named).toContain('icon--lg');
  const icons = record().filter((a) => a.kind === 'icon-set');
  expect(icons).toHaveLength(1);
  expect(['MIT', 'ISC', 'Apache-2.0']).toContain(icons[0]?.licence);
});

it('MP-1-2 no icon font or emoji glyph remains in the interface', () => {
  const offenders: string[] = [];
  const scan = (path: string): void => {
    const text = read(path);
    if (/\bfi-rr-|\bfi fi-|uicons/iu.test(text)) offenders.push(`${path}: icon font`);
    if (/\p{Extended_Pictographic}/u.test(text)) offenders.push(`${path}: emoji`);
  };
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(tsx?|css|html|svg)$/u.test(entry.name)) scan(path);
    }
  };
  walk(`${ui}src`);
  walk(`${root}apps/web/src`);
  scan(`${root}apps/web/index.html`);
  expect(offenders).toEqual([]);
});

it('MP-1-2 an asset with no compatible licence is refused and reported', () => {
  // The three named font packages pass under the font licence.
  for (const font of FONTS) expect(licences(ofl(font.pkg)).status, font.pkg).toBe(0);
  // Anything else under it is refused, and the report names the package.
  const hostile = [
    'some-widget',
    '@fontsource/funnel-sans-extra',
    '@FONTSOURCE/FUNNEL-SANS',
    ' @fontsource/funnel-sans',
    '@fontsource/funnel-sans ',
    '@evil/@fontsource/funnel-sans',
  ];
  for (const name of hostile) {
    const run = licences(ofl(name));
    expect(run.status, JSON.stringify(name)).toBe(1);
    expect(run.out, JSON.stringify(name)).toContain('OFL-1.1');
  }
  // A vendor icon font's licence (as Flaticon's) is refused and named.
  const vendor = licences({ 'SEE LICENSE IN LICENSE': [{ name: 'uicons', version: '3.0.0' }] });
  expect(vendor.status).toBe(1);
  expect(vendor.out).toContain('uicons');
  // A font licence joined to a refused one, or carrying an exception, is not a font licence.
  expect(licences(ofl('@fontsource/funnel-sans', 'OFL-1.1 OR SSPL-1.0')).status).toBe(1);
  expect(licences(ofl('@fontsource/funnel-sans', 'OFL-1.1 WITH Font-exception-2.0')).status).toBe(
    1,
  );
  // Other spellings of the font licence are not the one decided.
  expect(licences(ofl('@fontsource/funnel-sans', 'OFL-1.0')).status).toBe(1);
  expect(licences(ofl('@fontsource/funnel-sans', 'ofl-1.1')).status).toBe(1);
});

it('MP-1-2 the wordmark and planet masks are present', () => {
  for (const [variant, file, viewBox] of [
    ['wordmark', 'wordmark.svg', '0 0 566.93 57.9'],
    ['planet', 'planet.svg', '0 0 566.93 463.61'],
  ] as const) {
    const svg = read(`${ui}src/brand/${file}`);
    expect(svg).toContain(`viewBox="${viewBox}"`);
    // A mask image is drawn, never run: no script, handler, link or foreign content.
    expect(svg).not.toMatch(
      /<script|\son[a-z]+\s*=|href|<foreignObject|url\(|<!ENTITY|<!DOCTYPE/iu,
    );
    const html = renderToStaticMarkup(<BrandMark variant={variant} />);
    expect(html).toContain(`brand brand--${variant}`);
    expect(html).toContain('aria-hidden="true"');
  }
  const shell = read(`${ui}src/styles/3-shell.css`);
  expect(shell).toMatch(/\.brand--wordmark\s*\{[^}]*mask:\s*url\('\.\.\/brand\/wordmark\.svg'\)/su);
  expect(shell).toMatch(/\.brand--planet\s*\{[^}]*mask:\s*url\('\.\.\/brand\/planet\.svg'\)/su);
  // The expanded rail carries the wordmark above the product's own name.
  const rail = renderToStaticMarkup(
    <Shell
      face="agency"
      rail={[]}
      here="/"
      title="Board"
      dock={[]}
      onDockTab={() => {}}
      seated={false}
    >
      {null}
    </Shell>,
  );
  expect(rail).toMatch(/class="rail__brand"><span class="brand brand--wordmark"[^>]*><\/span>/u);
  expect(rail).toContain('class="rail__hub">Ops Astro</span>');
});

it('MP-1-2 each bundled asset has its licence recorded', () => {
  const assets = record();
  const ids = assets.map((a) => a.id);
  expect(new Set(ids).size).toBe(ids.length);
  // Every runtime dependency of the interface package is a bundled asset with a record.
  const deps = uiDependencies();
  const packaged = assets.filter((a) => a.package !== undefined);
  expect(packaged.map((a) => a.package).toSorted()).toEqual(Object.keys(deps).toSorted());
  for (const asset of packaged) {
    const name = String(asset.package);
    const installed = json<{ version: string; license: string }>(
      `${ui}node_modules/${name}/package.json`,
    );
    expect(asset.version, name).toBe(deps[name]);
    expect(installed.version, name).toBe(deps[name]);
    expect(installed.license, name).toBe(asset.licence);
  }
  // Every file in the brand folder has a record, and every record's file exists.
  const brandFiles = readdirSync(`${ui}src/brand`).map((f) => `src/brand/${f}`);
  const brand = assets.filter((a) => a.kind === 'brand-mark');
  expect(brand.map((a) => a.path).toSorted()).toEqual(brandFiles.toSorted());
  for (const asset of assets) {
    expect(asset.source, asset.id).not.toBe('');
    expect(existsSync(`${ui}assets/${asset.licenceFile}`), asset.licenceFile).toBe(true);
  }
});

it('MP-1-2 WEB.md points to the licence records, not to #32', () => {
  const web = read(`${root}docs/local/WEB.md`);
  expect(web).not.toMatch(/#32\b/u);
  expect(web).toContain('packages/ui/assets/licences.json');
  expect(read(`${ui}src/surfaces/Shell.tsx`)).not.toMatch(/#32\b/u);
});

it.todo(
  "MP-1-2 visual match: type and icon specimens at 1480, 900 and 390, light and dark (MP-1-7 harness; waits on T4b1's signed-in fixture, the gallery asks for a session)",
);
