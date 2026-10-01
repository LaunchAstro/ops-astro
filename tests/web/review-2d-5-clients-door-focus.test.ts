// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2D-5: each Clients row's door (`.clbook__door`, Clients.tsx) is the
// row's only focusable element. A `visibility: hidden` ancestor makes a link
// unfocusable, so `:focus-within` on the row can never fire to reveal it: a
// keyboard user above 900 px cannot Tab to any door. Hiding until hover is
// fine only where the device can hover, inside `@media (hover: hover)`.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SHEET = readFileSync('packages/ui/src/styles/11-clients.css', 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
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

const canHover = (query: string): boolean => /\(\s*hover\s*:\s*hover\s*\)/.test(query);

/** A selector part that lands on the door or its wrapper at rest (no state pseudo-class). */
const atRest = (part: string): boolean =>
  /\.clbook__(go|door)\b/.test(part) && !/:(hover|focus|focus-within|focus-visible|active)\b/.test(part);

describe('REVIEW-2D-5: the Clients row door stays focusable for the keyboard', () => {
  it('REVIEW-2D-5: no rule hides .clbook__go or .clbook__door with visibility outside @media (hover: hover)', () => {
    const offenders = rules(SHEET)
      .filter((rule) => !rule.media.some(canHover))
      .filter((rule) => rule.selector.split(',').some(atRest))
      .filter((rule) => /visibility\s*:\s*hidden/.test(rule.body))
      .map((rule) => [...rule.media, rule.selector].join(' > '));
    expect(
      offenders,
      'a visibility:hidden door cannot take focus, so :focus-within never reveals it',
    ).toEqual([]);
  });
});
