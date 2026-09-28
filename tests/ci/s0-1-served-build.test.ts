// SPDX-License-Identifier: AGPL-3.0-only
//
// `S0-1 served build` (ticket S0-1, supporting line C8, carried from CQ-14 and
// product issue 57): the browser rows I10, R4 and N6 call `servedIdentity`,
// print the `served` line, and match it against the version stamp; red with
// no stamp.
//
// The browser run itself is evidence, not a required check (it restarts the
// API and the database). What a required check can hold is the rule each row
// applies, which is `servedBuildVerdict`, and the fact that the checklist's
// entry point applies it in front of each of the three groups.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { servedBuildVerdict, stampInDocument } from '../browser/served-build.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const source = (path: string): string => readFileSync(`${root}${path}`, 'utf8');

const STAMP = '0123456789ab';

describe('S0-1 served build', () => {
  it('matches when the page, its served document and the checkout agree', () => {
    const verdict = servedBuildVerdict({
      label: 'i10',
      shown: STAMP,
      entry: STAMP,
      expected: STAMP,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.line).toBe(
      `served i10 build page=${STAMP} entry=${STAMP} expected=${STAMP} match`,
    );
  });

  it('is red with no stamp on the page', () => {
    for (const shown of [null, undefined, '']) {
      const verdict = servedBuildVerdict({ label: 'r4', shown, entry: STAMP, expected: STAMP });
      expect(verdict.ok).toBe(false);
      expect(verdict.line).toContain('page=none');
      expect(verdict.line).toMatch(/no stamp$/u);
    }
  });

  it('is red with no stamp in the served document', () => {
    const verdict = servedBuildVerdict({
      label: 'n6',
      shown: STAMP,
      entry: undefined,
      expected: STAMP,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.line).toMatch(/entry=none .* no stamp$/u);
  });

  it('is red when another build served the page', () => {
    const other = 'fedcba987654';
    for (const [shown, entry] of [
      [other, other],
      [STAMP, other],
      [other, STAMP],
    ] as const) {
      const verdict = servedBuildVerdict({ label: 'i10', shown, entry, expected: STAMP });
      expect(verdict.ok).toBe(false);
      expect(verdict.line).toMatch(/MISMATCH$/u);
    }
  });

  it('is red when the stamp to match against is unknown', () => {
    const verdict = servedBuildVerdict({
      label: 'i10',
      shown: STAMP,
      entry: STAMP,
      expected: undefined,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.line).toContain('expected=none');
  });

  it('reads the stamp from the served entry document, and only a well-formed one', () => {
    expect(stampInDocument(`<head><meta name="ops-astro-build" content="${STAMP}"></head>`)).toBe(
      STAMP,
    );
    expect(stampInDocument(`<meta name="ops-astro-build" content="${STAMP}-dirty" />`)).toBe(
      `${STAMP}-dirty`,
    );
    expect(stampInDocument('<head><title>Ops Astro</title></head>')).toBeUndefined();
    expect(stampInDocument('<meta name="ops-astro-build" content="latest">')).toBeUndefined();
  });

  it('rows I10, R4 and N6 print the served line against the stamp before each runs', () => {
    const entry = source('tests/browser/slice-acceptance.mjs');
    for (const [row, group] of [
      ['I10', 'casesI10OpenPage(run)'],
      ['R4', 'casesR4SharedPage(run)'],
      ['N6', 'casesN6(run)'],
    ] as const) {
      const served = entry.indexOf(`await servedBuild(browser, '${row}')`);
      const runs = entry.indexOf(group);
      expect(served, `${row} prints its served line`).toBeGreaterThan(-1);
      expect(runs, `${row}'s group runs`).toBeGreaterThan(served);
      // Nothing but the row's own group sits between its served line and it.
      expect(entry.slice(served, runs)).not.toMatch(/await cases/u);
    }
  });

  it('the harness row calls servedIdentity, applies the verdict and records the row', () => {
    const harness = source('tests/browser/harness.mjs');
    const at = harness.indexOf('export async function servedBuild(');
    expect(at).toBeGreaterThan(-1);
    const body = harness.slice(at, harness.indexOf('\n}\n', at));
    expect(body).toContain('await servedIdentity(page');
    expect(body).toContain('servedBuildVerdict(');
    expect(body).toMatch(/record\(\{\s*case: `S0-1 served build \$\{row\}`/u);
  });
});
