// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2D-5 (re-review, rev-css): the proof's `@media (hover: hover)` carve-out
// lets the exact 2d-5 bug back in. A desktop with a mouse matches (hover: hover)
// and its keyboard and screen-reader users still cannot focus a door under a
// `visibility: hidden` (or `display: none`) box, so `:focus-within` never fires.
// The door may hide at rest only in ways that keep it focusable (opacity), in
// any media.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SHEET = readFileSync('packages/ui/src/styles/11-clients.css', 'utf8').replaceAll(
  /\/\*[\s\S]*?\*\//gu,
  '',
);

interface Rule {
  readonly media: readonly string[];
  readonly selector: string;
  readonly body: string;
}

/** Every style rule in the sheet, with the `@media` queries that enclose it. */
function rules(css: string): Rule[] {
  const found: Rule[] = [];
  const stack: string[] = [];
  let prelude = '';
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index];
    if (char === '{') {
      const head = prelude.trim();
      if (head.startsWith('@')) {
        stack.push(head);
        prelude = '';
        continue;
      }
      const close = css.indexOf('}', index);
      found.push({ media: [...stack], selector: head, body: css.slice(index + 1, close) });
      index = close;
      prelude = '';
      continue;
    }
    if (char === '}') {
      stack.pop();
      prelude = '';
      continue;
    }
    prelude += char;
  }
  return found;
}

/** A selector part that lands on the door or its wrapper at rest (no state pseudo-class). */
const atRest = (part: string): boolean =>
  /\.clbook__(go|door)\b/u.test(part) &&
  !/:(hover|focus|focus-within|focus-visible|active)\b/u.test(
    part.replaceAll(/:not\([^)]*\)/gu, ''),
  );

describe('REVIEW-2D-5 (re-review): the door stays focusable whatever the device can hover', () => {
  it('no rule, in any media, hides .clbook__go or .clbook__door at rest with visibility or display', () => {
    const offenders = rules(SHEET)
      .filter((rule) => rule.selector.split(',').some((part) => atRest(part)))
      .filter((rule) => /visibility\s*:\s*(hidden|collapse)|display\s*:\s*none/u.test(rule.body))
      .map((rule) => [...rule.media, rule.selector].join(' > '));
    expect(offenders, 'an unfocusable door never fires :focus-within').toEqual([]);
  });
});
