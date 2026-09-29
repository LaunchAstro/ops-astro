// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-4: every text style on the declared scale, proved by a census.
//
// The census is `scripts/type-census.mjs`, the same scanner the check runs, so
// the tests read what it reads: every product stylesheet and every component
// file. Every route draws from those sheets, so the census over them covers the
// ten shell-inventory routes and the routes built since. The per-route measure
// at 1480, 900 and 390 in both themes runs on MP-1-7's harness and is `todo`
// until those routes' pages and T4b1's signed-in fixture exist.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const script = `${root}scripts/type-census.mjs`;
const tokensCss = `${root}packages/ui/src/styles/1-tokens.css`;
const read = (path: string): string => readFileSync(path, 'utf8');

interface Style {
  readonly id: string;
  readonly name: string;
  readonly font: string;
  readonly tracking: string;
  readonly case: string;
}
interface Fixture {
  readonly styles: readonly Style[];
  readonly numberStyles: readonly string[];
  readonly primitives: Readonly<Record<string, string>>;
  readonly exceptions: readonly { readonly selector: string; readonly ruling: string }[];
}
interface Census {
  readonly declared: readonly string[];
  readonly used: Readonly<Record<string, number>>;
  readonly aboveTwenty: readonly string[];
  readonly exceptions: readonly {
    readonly file: string;
    readonly selector: string;
    readonly ruling: string;
    readonly overrides: readonly string[];
  }[];
  readonly violations: readonly string[];
}

const fixture = JSON.parse(
  read(`${root}tests/surfaces/fixtures/mp-1-4-type-scale.json`),
) as Fixture;

const run = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const out = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
};
const census = (...args: string[]): Census => JSON.parse(run('--json', ...args).stdout) as Census;

const scratch = mkdtempSync(join(tmpdir(), 'mp-1-4-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
let planted = 0;
/** Runs the census over one planted stylesheet (and optionally one component file) against the real token file. */
const plant = (css: string, tsx?: string): ReturnType<typeof run> => {
  planted += 1;
  const sheet = join(scratch, `planted-${String(planted)}.css`);
  writeFileSync(sheet, css);
  const args = ['--tokens', tokensCss, '--css', sheet];
  if (tsx !== undefined) {
    const file = join(scratch, `planted-${String(planted)}.tsx`);
    writeFileSync(file, tsx);
    args.push('--tsx', file);
  }
  return run(...args);
};
const ok =
  '.x {\n  font: var(--type-body);\n  letter-spacing: var(--type-body-tracking);\n  text-transform: var(--type-body-case);\n}\n';

// It bites, and names the rule, on every stray the census must refuse.
const REFUSED: readonly [string, string, string?][] = [
  ['a literal size', '.a { font-size: 13px }', '.a'],
  ['an em size', '.b { font-size: 0.78em }', '.b'],
  ['a size token alone', '.c { font-size: var(--text-sm) }', '.c'],
  ['a weight alone', '.d { font-weight: 600 }', '.d'],
  ['a family alone', '.e { font-family: var(--font-mono) }', '.e'],
  ['a line height alone', '.f { line-height: 1.4 }', '.f'],
  ['tracking alone', '.g { letter-spacing: 0.02em }', '.g'],
  ['case alone', '.h { text-transform: uppercase }', '.h'],
  ['a literal shorthand', '.k { font: 500 13px/1 sans-serif }', '.k'],
  [
    'an undeclared style',
    '.l { font: var(--type-nope); letter-spacing: 0; text-transform: none }',
    '.l',
  ],
  [
    'another style’s tracking',
    '.m { font: var(--type-chip); letter-spacing: var(--type-body-tracking); text-transform: var(--type-chip-case) }',
    '.m',
  ],
  [
    'a style without its case',
    '.n { font: var(--type-chip); letter-spacing: var(--type-chip-tracking) }',
    '.n',
  ],
  ['upper-case property', '.o { FONT-SIZE: 13px }', '.o'],
  ['important', '.p { font-size: 13px !important }', '.p'],
  ['nested in a media query', '@media (width <= 640px) { .q { font-size: 28px } }', '.q'],
  ['nested twice', '@supports (display: grid) { @media print { .r { font-weight: 700 } } }', '.r'],
  ['after a brace in a string', ".s::after { content: '}' ; font-size: 9px }", '.s::after'],
  ['after a comment holding a brace', '.t { /* } */ font-size: 9px }', '.t'],
  ['a marker with no ruling', '.u { /* type-exception: looks nicer */ font-size: 9px }', '.u'],
  [
    'a marker in the neighbouring rule',
    '.v { /* type-exception DR-6: run hero */ }\n.w { font-size: 20px }',
    '.w',
  ],
  ['tracking tab-separated', '.y {\tletter-spacing:\t0.02em\t}', '.y'],
];

/** The product's own sheets and components pass the census. */
function productPasses(): void {
  const product = run();
  expect(product.stderr).toBe('');
  expect(product.status).toBe(0);
  expect(census().violations).toEqual([]);
}

/** Whole styles, inherited form controls and a font face all pass. */
function positiveControls(): void {
  // Positive controls: a whole style, form controls inheriting, a font face.
  expect(plant(ok).status).toBe(0);
  expect(
    plant(
      '.i { font: inherit; letter-spacing: inherit; text-transform: inherit }\n@font-face { font-family: X; font-weight: 300; src: url(x.woff2) }\n',
    ).status,
  ).toBe(0);
}

/** Each planted stray fails the census, naming its rule. */
function straysRefused(): void {
  for (const [what, css, selector] of REFUSED) {
    const out = plant(css);
    expect(out.status, `${what}: ${out.stderr}`).toBe(1);
    expect(out.stderr, what).toContain(selector);
  }
}

/** A component file's inline font style or SVG font attribute fails; a plain class passes. */
function componentFilesRefused(): void {
  // Component files: an inline font style or an SVG font attribute is refused.
  const inline = plant(ok, 'export const A = () => <span style={{ fontSize: 13 }}>a</span>;\n');
  expect(inline.status).toBe(1);
  expect(inline.stderr).toContain('fontSize');
  const svg = plant(ok, 'export const B = () => <text fontSize="10">b</text>;\n');
  expect(svg.status).toBe(1);
  expect(svg.stderr).toContain('fontSize');
  const dashed = plant(ok, "export const C = () => <text font-weight='600'>c</text>;\n");
  expect(dashed.status).toBe(1);
  expect(dashed.stderr).toContain('font-weight');
  expect(plant(ok, 'export const D = () => <span className="x">fontless</span>;\n').status).toBe(0);
}

describe('MP-1-4 type scale', () => {
  it.todo(
    "MP-1-4 visual match: matches mockup the ten census routes in the shell inventory at 1480, 900 and 390, light and dark (MP-1-7 harness; waits on those routes' pages in later slices and T4b1's signed-in fixture)",
  );
});

describe('MP-1-4 type scale', () => {
  it('MP-1-4 every text style maps to a declared type token', () => {
    productPasses();
    positiveControls();
    straysRefused();
    componentFilesRefused();
  });
});

describe('MP-1-4 type scale', () => {
  it('MP-1-4 a census over the same ten routes shows 20 or fewer styles, or lists each exception', () => {
    const got = census();
    const used = Object.keys(got.used);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) expect(got.declared, name).toContain(name);
    const beyondNumbers = used.filter((name) => !fixture.numberStyles.includes(name));
    expect(beyondNumbers.length).toBeLessThanOrEqual(20);
    // Each exception is listed with the ruling that keeps it, and no other exists.
    expect(got.exceptions.map(({ selector, ruling }) => ({ selector, ruling }))).toEqual(
      fixture.exceptions,
    );
    for (const exception of got.exceptions) expect(exception.overrides.length).toBeGreaterThan(0);
    // A marked exception is listed, not refused.
    const marked = plant(
      `${ok}.z {\n  /* type-exception DR-6: the run hero's mono 20 number */\n  font: var(--type-mono);\n  letter-spacing: var(--type-mono-tracking);\n  text-transform: var(--type-mono-case);\n  font-size: var(--text-h2);\n}\n`,
    );
    expect(marked.status, marked.stderr).toBe(0);
  });
});

describe('MP-1-4 type scale', () => {
  it('MP-1-4 the canonical scale has 23 (TOKENS.md), and the three exceptions above 20 are --type-num-lg, --type-num-md and --type-num-sm', () => {
    const got = census();
    expect(fixture.styles).toHaveLength(23);
    expect(got.declared.toSorted()).toEqual(fixture.styles.map((style) => style.name).toSorted());
    expect(got.aboveTwenty).toEqual(fixture.numberStyles);

    const declared = new Map<string, string>();
    const bare = read(tokensCss).replaceAll(/\/\*[\s\S]*?\*\//gu, '');
    const rootBlock = bare.slice(bare.indexOf(':root'), bare.indexOf('}', bare.indexOf(':root')));
    for (const line of rootBlock.split(';')) {
      const at = line.indexOf(':');
      const name = line.slice(0, at).trim().replace(/^.*\{/su, '').trim();
      if (name.startsWith('--'))
        declared.set(
          name,
          line
            .slice(at + 1)
            .replaceAll(/\s+/gu, ' ')
            .trim(),
        );
    }
    for (const style of fixture.styles) {
      expect(declared.get(style.name), `${style.id} ${style.name}`).toBe(style.font);
      expect(declared.get(`${style.name}-tracking`), `${style.name}-tracking`).toBe(style.tracking);
      expect(declared.get(`${style.name}-case`), `${style.name}-case`).toBe(style.case);
    }
    for (const [name, value] of Object.entries(fixture.primitives)) {
      expect(declared.get(name), name).toBe(value);
    }
  });

  it.todo(
    'MP-1-4 owner check: five pages side by side with the mockup, sizes and weights the same (staging, S0-1)',
  );
});
