// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-9-1: the page kit places the component kit's primitives and never
// restyles them (lane FINAL-FOLD). The page kit's stylesheet is read as it
// ships, and the check is given hostile stylesheets of its own.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error -- jsdom ships no declarations; this check reads only its CSSOM
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

// The component kit's classes the page kit places (MP-1-3): every class the
// kit's two stylesheets define, and the ones its table, banner, meter, stat,
// term tip and facet parts draw.
const KIT_PLACED = [
  'banner',
  'banner__body',
  'banner__x',
  'banner--info',
  'facet',
  'facet__num',
  'facets',
  'marker',
  'meter',
  'meter__fill',
  'meter__target',
  'meter--stat',
  'sec',
  'sec__head',
  'stat',
  'stat__foot',
  'stat__label',
  'stat__num',
  'stat__of',
  'table',
  'table__arrow',
  'table__sort',
  'tablewrap',
  'term',
  'term__tip',
  'visually-hidden',
];

const styles = (name: string): string =>
  readFileSync(join(process.cwd(), 'packages/ui/src/styles', name), 'utf8');

function kitClasses(): ReadonlySet<string> {
  const defined = ['2-primitives.css', '2-controls-and-marks.css'].flatMap((sheet) =>
    [...styles(sheet).matchAll(/\.(-?[_a-zA-Z][\w-]*)/gu)].map((match) => match[1] ?? ''),
  );
  return new Set([...KIT_PLACED, ...defined]);
}

// Every selector a stylesheet holds, read by a real CSS parser (jsdom's
// CSSOM): comments, strings and at-rule blocks are the parser's, and a nested
// rule is read with its parent's selector in front, and each selector keeps
// the properties its rule declares.
const { window } = new JSDOM('') as { window: { CSSStyleSheet: typeof CSSStyleSheet } };
interface Parsed {
  readonly selectorText?: string;
  readonly cssRules?: Iterable<Parsed>;
  readonly style?: ArrayLike<string>;
}
interface Ruled {
  readonly selector: string;
  readonly properties: readonly string[];
}
function selectorsOf(css: string): readonly Ruled[] {
  const sheet = new window.CSSStyleSheet();
  sheet.replaceSync(css);
  const found: Ruled[] = [];
  const walk = (rules: Iterable<Parsed>, parents: readonly string[]): void => {
    for (const rule of rules) {
      let inner = parents;
      if (rule.selectorText !== undefined) {
        const own = split(rule.selectorText, ',');
        inner =
          parents.length === 0
            ? own
            : parents.flatMap((parent) =>
                own.map((child) =>
                  child.includes('&') ? child.replaceAll('&', parent) : `${parent} ${child}`,
                ),
              );
        const properties = Array.from(rule.style ?? []);
        found.push(...inner.map((selector) => ({ selector, properties })));
      }
      if (rule.cssRules !== undefined) walk(rule.cssRules, inner);
    }
  };
  walk(sheet.cssRules as Iterable<Parsed>, []);
  return found;
}

// The CSS tokens a selector is read by: an escape (up to six hex digits and
// one optional space, or any one character), a name, and a quoted string.
const ESCAPE = /^\\(?:[\da-f]{1,6}\s?|[\s\S])/iu;
const NAME = /^(?:[\w\u0080-\uFFFF-]|\\(?:[\da-f]{1,6}\s?|[\s\S]))*/iu;
const STRING = /^"(?:[^"\\]|\\[\s\S])*"?|^'(?:[^'\\]|\\[\s\S])*'?/u;
function decoded(text: string): string {
  return text.replaceAll(/\\(?:([\da-f]{1,6})\s?|([\s\S]))/giu, (_, hex?: string, one?: string) => {
    const code = Number.parseInt(hex ?? '', 16);
    if (Number.isNaN(code)) return one ?? '';
    const valid = code > 0 && code <= 0x10_ffff && (code < 0xd8_00 || code > 0xdf_ff);
    return valid ? String.fromCodePoint(code) : '\uFFFD';
  });
}

// A selector text cut at each top-level `,` (a group's selectors) or at each
// combinator (a selector's compounds); brackets, parentheses, strings and
// escapes (`.a\ .b` is one compound) stay whole.
function split(text: string, at: ',' | 'combinator'): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  const cut = (): void => {
    if (current.trim() !== '') parts.push(current.trim());
    current = '';
  };
  for (let index = 0; index < text.length; index += 1) {
    let character = text[index] ?? '';
    if (character === '\\') {
      character = ESCAPE.exec(text.slice(index))?.[0] ?? character;
      index += character.length - 1;
    } else if (quote !== '') {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    else if (depth === 0 && at === ',' && character === ',') {
      cut();
      continue;
    } else if (depth === 0 && at === 'combinator' && /[\s>+~]/u.test(character)) {
      cut();
      continue;
    }
    current += character;
  }
  cut();
  return parts;
}

// A compound read token by token: `take` consumes the token at the cursor.
interface Cursor {
  readonly text: string;
  at: number;
}
function take(cursor: Cursor, token: RegExp): string {
  const found = token.exec(cursor.text.slice(cursor.at))?.[0] ?? '';
  cursor.at += found.length;
  return found;
}

// The classes an attribute selector, read from just past its `[`, names. Only
// `class` counts, in any case or namespace. `~=` and `=` name their value's
// classes (any of the kit's under the `i` flag). A bare `[class]`, `^=`, `$=`,
// `*=` or `|=` can match a class list carrying any kit class beside the
// pattern, as can a selector this reader cannot close, so it names them all.
function attributeNames(cursor: Cursor, kit: ReadonlySet<string>): string[] {
  take(cursor, /^\s*/u);
  let name = take(cursor, /^\*/u) || take(cursor, NAME);
  if (take(cursor, /^\|(?!=)/u) !== '') name = take(cursor, NAME);
  const operator = take(cursor, /^\s*[~|^$*]?=\s*/u).trim();
  const value = decoded(take(cursor, STRING).slice(1, -1) || take(cursor, NAME));
  const loose =
    take(cursor, /^\s*[\w-]*\s*/u)
      .trim()
      .toLowerCase() === 'i';
  const closed = take(cursor, /^\]/u) !== '';
  if (!closed) take(cursor, /^[^\]]*\]?/u);
  if (decoded(name).toLowerCase() !== 'class') return [];
  if (!closed || (operator !== '=' && operator !== '~=')) return [...kit];
  const tokens = value.split(/\s+/u).filter((token) => token !== '');
  return tokens.flatMap((token) => {
    const same = [...kit].filter((kitClass) => kitClass.toLowerCase() === token.toLowerCase());
    return loose && same.length > 0 ? same : [token];
  });
}

// The classes one compound names: each `.class`, inside `:is()`, `:where()`,
// `:not()`, `:has()` and every other functional pseudo-class too, and each
// attribute selector on `class`. A string elsewhere names nothing.
function named(compound: string, kit: ReadonlySet<string>): string[] {
  const cursor: Cursor = { text: compound, at: 0 };
  const names: string[] = [];
  while (cursor.at < compound.length) {
    if (take(cursor, ESCAPE) !== '' || take(cursor, STRING) !== '') continue;
    const next = compound[cursor.at];
    cursor.at += 1;
    if (next === '.') names.push(decoded(take(cursor, NAME)));
    if (next === '[') names.push(...attributeNames(cursor, kit));
  }
  return names.filter((name) => name !== '');
}

// Every selector that styles a kit primitive rather than places it. A page
// part may place the primitive it holds: the selector's subject, its last
// compound, may name a kit class. Any other compound naming one restyles
// the primitive: the first (a rule on the primitive itself), or one between
// (a rule gated on a primitive's own state or part, as
// `.host .term:focus-visible .term__tip` hides the tip on keyboard focus).
// Placing that subject allows only placement declarations: a rule on it that
// sets anything else (`.host .term__tip { visibility: hidden; }`) restyles it.
const PLACEMENT =
  /^(?:margin(?:-.+)?|grid-(?:area|row|column)(?:-.+)?|order|flex(?:-grow|-shrink|-basis)?|(?:align|justify|place)-self)$/u;
function restyled(css: string, kit: ReadonlySet<string>): readonly string[] {
  return selectorsOf(css)
    .filter(({ selector, properties }) => {
      const compounds = split(selector, 'combinator');
      const placed = compounds.length > 1 && properties.every((name) => PLACEMENT.test(name));
      const reached = placed ? compounds.slice(0, -1) : compounds;
      return reached.some((compound) => {
        const classes = named(compound, kit);
        // A kit state (`is-on`) beside a page part's own class is the part's state,
        // not a restyle; a compound of kit states alone restyles every primitive.
        const primitive = classes.some((name) => kit.has(name) && !name.startsWith('is-'));
        const statesOnly = classes.length > 0 && classes.every((name) => kit.has(name));
        return primitive || statesOnly;
      });
    })
    .map(({ selector }) => selector);
}

describe('MP-9-1 primitives placed not restyled', () => {
  it('the page kit stylesheet styles no kit primitive, only the page parts that hold them', () => {
    expect(restyled(styles('7-page-kit.css'), kitClasses())).toEqual([]);
  });

  it('MP-7-10 the Team panel stylesheet styles no kit primitive either', () => {
    expect(restyled(styles('10-team.css'), kitClasses())).toEqual([]);
  });

  it('MP-7-3 and MP-8-4 the notifications and ledger stylesheets style no kit primitive either', () => {
    expect(restyled(styles('8-notifications.css'), kitClasses())).toEqual([]);
    expect(restyled(styles('9-ledger.css'), kitClasses())).toEqual([]);
  });

  it('the kit marks sheet counts too: a restyle of its avatar or term tip is found', () => {
    const kit = kitClasses();
    expect(restyled('.av { x: 1 }', kit)).not.toEqual([]);
    expect(restyled('.term__tip { x: 1 }', kit)).not.toEqual([]);
    expect(restyled('.is-on { x: 1 }', kit)).not.toEqual([]);
    expect(restyled('.av.is-on { x: 1 }', kit)).not.toEqual([]);
    expect(restyled('.tmc__p.is-on .tmc__n { x: 1 }', kit)).toEqual([]);
  });

  it('the check finds a restyle however the stylesheet hides it', () => {
    const kit = kitClasses();
    const planted = [
      '.stat { color: red; }',
      '/* .statrow {} */ .meter__fill { width: 1px; }',
      '@media (width <= 640px) {\n  .page { x: 1 }\n  .TABLE, .table { x: 1 }\n}',
      '.barlist,\n\t.banner--info { x: 1 }',
      ':is(.term) .x { x: 1 }',
      'aside.banner--hint > .y { x: 1 }',
      '.host .term:focus-visible .term__tip { display: none; }',
      '.host { & .term:hover .term__tip { display: none; } }',
      '.host [class~="term__tip"] { visibility: hidden; }',
      ".host [ CLASS ~= 'TERM__TIP' i ] { color: red; }",
      '.host [*|class="x term__tip"] { color: red; }',
      '.host [cl\\61ss=term\\_\\_tip] { color: red; }',
      '.host [class*="term"] { color: red; }',
      '.host :where([class|="x"]) .y { x: 1 }',
      '.host:has(> .term__tip) .y { x: 1 }',
      '.host :not(.term) .y { x: 1 }',
      '.x\\ .term__tip { margin: 0 }',
    ];
    for (const css of planted) expect(restyled(css, kit), css).not.toEqual([]);
    expect(restyled('.statrow > .stat { x: 1 } .statrow .stat__num { x: 1 }', kit)).toEqual([]);
  });
});

describe('MP-9-1 the page kit ships no stand-in for a kit primitive', () => {
  it('the hint stand-in sheet is gone and nothing imports it', () => {
    const dir = join(process.cwd(), 'packages/ui/src');
    expect(existsSync(join(dir, 'styles/6-kit-standin.css'))).toBe(false);
    expect(readFileSync(join(dir, 'index.ts'), 'utf8')).not.toMatch(/kit-standin/u);
  });
});
