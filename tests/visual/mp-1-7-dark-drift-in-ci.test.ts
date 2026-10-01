// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { builtPages } from './report.ts';

describe('MP-1-7 re-review', () => {
  it('public CI proves dark drift on a built page', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    );
    const catalogue = JSON.parse(readFileSync(new URL('states.json', import.meta.url), 'utf8')) as {
      appDrift: { page: string; theme: string };
    };
    const mode = readFileSync(new URL('app-drift.ts', import.meta.url), 'utf8');
    expect(workflow).toContain('node tests/visual/run.ts --app-drift --app');
    expect(catalogue.appDrift.theme).toBe('dark');
    expect(builtPages()).toContain(catalogue.appDrift.page);
    expect(mode).toContain('const lightPage = await load(light, packet, url)');
    expect(mode).toContain('draws the same as light; the page has no dark theme');
  });
});
