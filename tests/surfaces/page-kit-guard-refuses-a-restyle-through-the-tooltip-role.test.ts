// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
// @ts-expect-error jsdom has no declarations in this project
import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';
import { continued } from './css-continued.ts';
import { tipShown } from './term-tip-drawn.ts';

it('the page-kit guard refuses a parent-scoped restyle through the tooltip role', async () => {
  const markup =
    '<div class="host"><span class="term" tabindex="0" aria-describedby="tip">Hours<span class="term__tip" id="tip" role="tooltip">Tracked time.</span></span></div>';
  expect((await tipShown(markup))['focus']).toBe(true);
  const restyle = '.host [role="tooltip"] { visibility: hidden !important; }';
  const hidden = await tipShown(markup + '<style>' + restyle + '</style>');
  expect(hidden['hover']).toBe(false);
  expect(hidden['focus']).toBe(false);
  const source = readFileSync('tests/surfaces/mp-9-1-page-kit-styles.test.ts', 'utf8');
  const start = source.indexOf('const KIT_PLACED');
  const end = source.indexOf("describe('MP-9-1 primitives");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const check = new Function(
    'JSDOM',
    'readFileSync',
    'join',
    'continued',
    stripTypeScriptTypes(
      source.slice(start, end) +
        '\nfunction check(css: string) { return restyled(css, kitClasses()); }',
    ) + '\nreturn check;',
  );
  const restyled = check(JSDOM, readFileSync, join, continued);
  expect(restyled(restyle)).not.toEqual([]);
}, 60_000);
