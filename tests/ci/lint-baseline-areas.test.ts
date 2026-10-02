// SPDX-License-Identifier: AGPL-3.0-only
//
// CI-SCOPED: the lint baseline split into one file per area, so lanes stop
// editing one hot file. These cases cover the pure functions: counting per
// area, reading the folder or the single file, and splitting and joining
// without losing or inventing an entry, on fixtures and on this repository's
// real warnings.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type Diagnostic,
  countByArea,
  joinAreas,
  parseAreaFiles,
  parseRules,
  readBaseline,
  splitBaseline,
} from '../../scripts/lint-baseline-areas.ts';

const ROOT = join(import.meta.dirname, '../..');
const RULE = 'unicorn(no-useless-undefined)';
const OTHER = 'eslint(no-negated-condition)';
const text = (rules: Record<string, unknown>) => `${JSON.stringify({ rules })}\n`;
const d = (filename: string, code = RULE, severity = 'warning'): Diagnostic => ({
  filename,
  code,
  severity,
});

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe('CI-SCOPED lint areas: counting, splitting and joining', () => {
  it('counts warnings per area per rule, and leaves errors out as the ratchet does today', () => {
    const areas = countByArea([
      d('apps/web/src/a.ts'),
      d('apps/web/src/b.ts'),
      d('apps/web/src/b.ts', OTHER),
      d('scripts/x.mjs'),
      d('scripts/x.mjs', OTHER, 'error'),
      d('package.json'),
    ]);
    expect(areas).toEqual({
      'apps-web': { [RULE]: 2, [OTHER]: 1 },
      scripts: { [RULE]: 1 },
      root: { [RULE]: 1 },
    });
  });

  it('split then join equals the original totals for every rule', () => {
    const current = { 'apps-web': { [RULE]: 2, [OTHER]: 1 }, 'tests-ci': { [RULE]: 3 } };
    const single = { [RULE]: 5, [OTHER]: 1 };
    const areas = splitBaseline(single, current);
    expect(areas).toEqual(current);
    expect(joinAreas(areas)).toEqual(single);
  });

  it('split refuses unless the current counts equal the single baseline exactly, saying to run pnpm lint:baseline first', () => {
    const current = { 'apps-web': { [RULE]: 2 }, scripts: { [OTHER]: 1 } };
    // Slack in the single file would be lost; a rule it lacks would be invented.
    expect(() => splitBaseline({ [RULE]: 3, [OTHER]: 1 }, current)).toThrow(
      /run `pnpm lint:baseline` first/u,
    );
    expect(() => splitBaseline({ [RULE]: 2 }, current)).toThrow(
      `${OTHER}: 1 now, 0 in lint-baseline.json`,
    );
    // A rule recorded at 0 is the same as a rule not recorded.
    expect(joinAreas(splitBaseline({ [RULE]: 2, [OTHER]: 1, x: 0 }, current))).toEqual({
      [RULE]: 2,
      [OTHER]: 1,
    });
  });

  it('refuses to count a warning whose area could not name a baseline file', () => {
    expect(() => countByArea([d('Docs/x.ts')])).toThrow(/cannot name a baseline file/u);
  });
});

describe('CI-SCOPED lint areas: reading the baseline', () => {
  it('reads lint-baseline/<area>.json as per-area records when the folder exists, else the single file as one total', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-areas-'));
    made.push(dir);
    expect(readBaseline(dir)).toBeUndefined();
    writeFileSync(join(dir, 'lint-baseline.json'), text({ [RULE]: 3 }));
    expect(readBaseline(dir)).toEqual({ kind: 'total', rules: { [RULE]: 3 } });
    mkdirSync(join(dir, 'lint-baseline'));
    writeFileSync(join(dir, 'lint-baseline/apps-web.json'), text({ [RULE]: 1 }));
    writeFileSync(join(dir, 'lint-baseline/tests-ci.json'), text({ [RULE]: 2 }));
    expect(readBaseline(dir)).toEqual({
      kind: 'areas',
      areas: { 'apps-web': { [RULE]: 1 }, 'tests-ci': { [RULE]: 2 } },
    });
    mkdirSync(join(dir, 'lint-baseline/nested.json'));
    expect(() => readBaseline(dir)).toThrow(/nested\.json\/ is not a \.json file/u);
  });

  it.each([
    ['an unparsable file', 'scripts.json', '{', /scripts\.json is not JSON/u],
    ['no rules object', 'scripts.json', '{"rule":{}}', /has no `rules` object/u],
    ['a negative count', 'scripts.json', text({ [RULE]: -1 }), /is -1, not a count/u],
    ['a fractional count', 'scripts.json', text({ [RULE]: 1.5 }), /is 1\.5, not a count/u],
    ['a count given as text', 'scripts.json', text({ [RULE]: '2' }), /is "2", not a count/u],
    ['a non-.json file in the folder', 'README.md', '', /README\.md is not a \.json file/u],
    ['an area name areaOf could never produce', 'Apps_Web.json', text({}), /not an area name/u],
    ['an empty area name', '.json', text({}), /not an area name/u],
  ])('refuses %s', (_, name, body, message) => {
    expect(() => parseAreaFiles([{ name, text: body }], 'lint-baseline')).toThrow(message);
  });

  it('refuses the same faults in the single file', () => {
    expect(() => parseRules('{', 'lint-baseline.json')).toThrow(/is not JSON/u);
    expect(() => parseRules('{"rules":[]}', 'lint-baseline.json')).toThrow(/no `rules` object/u);
    expect(() => parseRules(text({ [RULE]: null }), 'lint-baseline.json')).toThrow(/not a count/u);
  });
});

/** This repository's real oxlint warnings, as the ratchet reads them. */
function realDiagnostics(): Diagnostic[] {
  const run = spawnSync(join(ROOT, 'node_modules/.bin/oxlint'), ['--format', 'json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const report = JSON.parse(run.stdout.slice(run.stdout.indexOf('{'))) as {
    diagnostics: Diagnostic[];
  };
  return report.diagnostics;
}

describe("CI-SCOPED lint areas: on this repository's real warnings", () => {
  const current = countByArea(realDiagnostics());
  const totals = joinAreas(current);

  it('split then join equals the real counts for every rule, and every real area names a file', () => {
    expect(Object.keys(current).length).toBeGreaterThan(3);
    expect(joinAreas(splitBaseline(totals, current))).toEqual(totals);
  });

  it("split then join equals main's real lint-baseline.json for every rule", (context) => {
    const single = parseRules(readFileSync(join(ROOT, 'lint-baseline.json'), 'utf8'), 'main');
    const slack = Object.entries(single).filter(([rule, n]) => n !== (totals[rule] ?? 0));
    if (slack.length > 0) {
      context.skip(`main's baseline is not tight: ${slack.map(([r]) => r).join(', ')}`);
    }
    expect(joinAreas(splitBaseline(single, current))).toEqual(single);
  });
});
