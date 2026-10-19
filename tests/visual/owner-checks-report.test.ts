// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { renderPack, stepLine, verdictOf, type UnitResult } from './owner-checks-report.ts';

const unit = (steps: UnitResult['steps'], video?: string): UnitResult => ({
  unit: 'U06',
  issue: 676,
  title: 'Rail, drawer, tab row',
  video,
  steps,
});

describe('the owner-check pack page', () => {
  it('calls a unit red when any step was, before a step that could not be shown', () => {
    expect(
      verdictOf(
        unit([
          { step: 'a', outcome: { kind: 'not here', why: 'needs the teammate' } },
          { step: 'b', outcome: { kind: 'red', why: 'no panel' } },
        ]),
      ),
    ).toBe('red');
    expect(verdictOf(unit([{ step: 'a', outcome: { kind: 'not here', why: 'x' } }]))).toBe(
      'partly',
    );
    expect(verdictOf(unit([{ step: 'a', outcome: { kind: 'ok' } }]))).toBe('ok');
  });

  it('prints a step with why it did not pass', () => {
    expect(stepLine({ step: 'Tap the menu', outcome: { kind: 'red', why: 'no drawer' } })).toBe(
      'red: Tap the menu (no drawer)',
    );
  });

  it('escapes step text and the film name, so a page title cannot write markup into the pack', () => {
    const html = renderPack({
      stamp: '73747fda4218',
      made: '18 Oct 2026',
      source: 'app.opsastro.com',
      units: [
        unit([{ step: '<img src=x onerror=alert(1)>', outcome: { kind: 'ok' } }], 'U06-"x.webm'),
      ],
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('src="U06-&quot;x.webm"');
    expect(html).toContain('Build <b>73747fda4218</b>');
    expect(html).toContain('on made-up data on app.opsastro.com');
    expect(html).toContain('https://github.com/LaunchAstro/ops-astro-roadmap/issues/676');
  });
});
