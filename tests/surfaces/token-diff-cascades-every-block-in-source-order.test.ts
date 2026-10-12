// SPDX-License-Identifier: AGPL-3.0-only
//
// The token diff resolves the token file as the browser cascades it: every
// top-level `:root` and dark block, in source order. A later block that
// changes a token is drift, and a dark block written before an ordinary
// `:root` declaration of equal specificity loses to it on the dark element.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Sets = { light: Record<string, string>; dark: Record<string, string> };
const DIFF = '../../scripts/token-diff.mjs';
const { diffTokens, resolveTokens } = (await import(
  /* @vite-ignore */
  DIFF
)) as {
  diffTokens: (css: string, expected: Sets) => string[];
  resolveTokens: (css: string) => Sets;
};

const tokens = readFileSync('packages/ui/src/styles/1-tokens.css', 'utf8');
const expected = JSON.parse(
  readFileSync('tests/surfaces/fixtures/mp-1-1-tokens.json', 'utf8'),
) as Sets;

describe('token diff cascade', () => {
  it('passes the token file as it is', () => {
    expect(diffTokens(tokens, expected)).toEqual([]);
  });

  it('names a later :root block that changes a token', () => {
    const problems = diffTokens(`${tokens}\n:root { --ink: red; }\n`, expected);
    expect(problems, 'a later block changed --ink and the diff stayed green').toContain(
      `light --ink: want ${expected.light['--ink']}, got red`,
    );
  });

  it('names a later dark block that changes a token', () => {
    const problems = diffTokens(`${tokens}\n[data-theme='dark'] { --ink: red; }\n`, expected);
    expect(problems).toContain(`dark --ink: want ${expected.dark['--ink']}, got red`);
  });

  it('gives the dark element a later ordinary :root value over an earlier dark one', () => {
    const css = "[data-theme='dark'] { --a: blue; }\n:root { --a: red; }\n";
    expect(resolveTokens(css), 'the earlier dark block won a tie it loses').toEqual({
      light: { '--a': 'red' },
      dark: { '--a': 'red' },
    });
    expect(diffTokens(css, { light: { '--a': 'red' }, dark: { '--a': 'blue' } })).toEqual([
      'dark --a: want blue, got red',
    ]);
  });
});
