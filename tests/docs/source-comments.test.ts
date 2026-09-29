// SPDX-License-Identifier: AGPL-3.0-only
//
// Product source comments state the rule the code keeps and why. A comment
// that cites a review round, a lane or a finding id points at a record a
// reader of this repository cannot open, and git already holds the history.
// This check reads every comment in `packages/` and `apps/` and refuses one
// that cites any of them. Decision and ruling ids and contract rule
// numbers that resolve in `docs/` (EX-01, C12-5, G06, R4 and the like) are
// not in the set: they name the rule.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseSync } from 'vite';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);

/** What a comment may not cite, by the label a failure reports. */
const CITATIONS: readonly (readonly [string, RegExp])[] = [
  ['a thermo review or recheck', /thermo/iu],
  ['a Sol review', /\bSol\b|\bSOL-[A-Z0-9]/iu],
  ['a numbered review finding', /\bR\d+-[A-Z]+-\d+|\b(?:RUNTIME|AUTHORITY|SURFACE)-(?:R-)?\d+\b/u],
  ['a finding by review and number', /\bR\d+ #\d+/u],
  ['a recheck finding code', /\b(?:NNA|NA|NB|NC)\d+\b/u],
  [
    'a review round',
    /\breview round|\bfinal review\b|\breview finding|\barchitecture review\b|\bround (?:\d+|one|two|three|four|five|six|seven|eight|nine)\b/iu,
  ],
  ['a lane', /\blanes?\b/iu],
  [
    'a review or proof record',
    /REVIEW-[A-Z]|-(?:PROOFS|AUDIT|SEAM|GENERATED)\b|\bDB-PROOF|\bFG-[A-Z]-\d+|\bCQ-\d+\b|\bTR-[A-Z]+-/u,
  ],
  ['a lane id', /\bL[1-9]\b/u],
  ['a numbered finding', /(?<![\w-])F[1-9](?![\w-])/u],
  ['an earlier draft', /t1-draft|\bearlier draft\b|\bthis comment said\b/iu],
  [
    'a story of earlier handling',
    /\bused to\b|\bwas once (?:derived|written|handled|computed|kept|claimed)\b|\bthat way until\b|\bcame off\b|\bleft this list\b|\bthe old handler\b|\bis what found\b/iu,
  ],
];

/** The citation a comment makes and the words that make it, or undefined. */
function citationIn(
  comment: string,
): { readonly label: string; readonly words: string } | undefined {
  for (const [label, pattern] of CITATIONS) {
    const match = pattern.exec(comment);
    if (match !== null) return { label, words: match[0] };
  }
  return undefined;
}

/** Which citation a comment makes, or undefined. */
const cites = (comment: string): string | undefined => citationIn(comment)?.label;

type CommentLine = { readonly line: number; readonly comment: string };

const LANGS = {
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'jsx',
} as const;

/** Formats whose comments are read by pattern. */
const STYLES: ReadonlySet<string> = new Set(['css', 'html']);

/** Formats that hold no comments, which the tree case skips by name. */
const NO_COMMENTS: ReadonlySet<string> = new Set(['json', 'gitkeep']);

/**
 * Every comment in `text`, one entry per source line it covers. A script's
 * comments come from the parser (vite's `parseSync`, which is oxc), so a
 * `//` or `/*` inside a string, a template or a regex is never read, and a
 * comment after code, with or without a space, always is. Two kinds the
 * parser does not report are read by pattern: a SQL `--` line, which sits
 * inside a query template, and an HTML comment. A stylesheet's comments are
 * its block comments. `errors` is what the parser could not read, or the
 * format itself when this check has no reader for it.
 */
function readComments(
  text: string,
  file = 'source.tsx',
): { readonly lines: CommentLine[]; readonly errors: readonly unknown[] } {
  const extension = file.slice(file.lastIndexOf('.') + 1);
  const spans: (readonly [number, number])[] = [];
  let errors: readonly unknown[] = [];
  if (Object.hasOwn(LANGS, extension)) {
    const parsed = parseSync(file, text, { lang: LANGS[extension as keyof typeof LANGS] });
    errors = parsed.errors;
    for (const { start, end } of parsed.comments) spans.push([start, end]);
    for (const sql of text.matchAll(/^[ \t]*--\s.*$/gmu)) {
      spans.push([sql.index, sql.index + sql[0].length]);
    }
  } else if (STYLES.has(extension)) {
    for (const block of text.matchAll(/\/\*[\s\S]*?\*\//gu)) {
      spans.push([block.index, block.index + block[0].length]);
    }
  } else {
    errors = [`${file} is not a format this check reads`];
  }
  for (const html of text.matchAll(/<!--[\s\S]*?-->/gu)) {
    spans.push([html.index, html.index + html[0].length]);
  }
  const lines = spans.flatMap(([start, end]) => {
    const first = text.slice(0, start).split('\n').length;
    return text
      .slice(start, end)
      .split('\n')
      .map((comment, offset) => ({ line: first + offset, comment }));
  });
  return { lines: lines.toSorted((a, b) => a.line - b.line), errors };
}

/**
 * Consecutive comment lines as one passage each, numbered by its first line,
 * with the comment markers and the wrapping folded out, so a phrase split
 * across two lines reads as it was written.
 */
function passages(lines: readonly CommentLine[]): CommentLine[] {
  const found: { line: number; comment: string }[] = [];
  let previous = -1;
  for (const { line, comment } of lines) {
    const words = comment
      .replace(/^\s*(?:\/\/+|\/\*+|\*|--|<!--)\s?/u, '')
      .replace(/\s*(?:\*\/|-->)\s*$/u, '')
      .trim();
    const current = found.at(-1);
    if (current !== undefined && line === previous + 1) current.comment += ` ${words}`;
    else found.push({ line, comment: words });
    previous = line;
  }
  return found;
}

/** The comment text on each line of `text`, with its line number. */
const commentLines = (text: string, file?: string): CommentLine[] => readComments(text, file).lines;

describe('a source comment cites no review round, lane or finding id', () => {
  it.each([
    ['// The door, the same on both prefixes (Sol 6 SURFACE-1, AUTHORITY-1).', 'a Sol review'],
    [
      ' * delegation and nothing has to find out again (THERMO-RECHECK NA1):',
      'a thermo review or recheck',
    ],
    [
      '// unchanged when the module was divided (thermo review b483399, H2).',
      'a thermo review or recheck',
    ],
    [
      '  // subject column and a restore has no single subject (R2-RUNTIME-55).',
      'a numbered review finding',
    ],
    ['  // not "another resource" (final review R1 #20).', 'a finding by review and number'],
    ['  // R1 #23). Neither names a lease.', 'a finding by review and number'],
    [' * prints as was NNA1.', 'a recheck finding code'],
    [' * review round 1, #11). Here it is a malformed body.', 'a review round'],
    [' * Round 3 found two more.', 'a review round'],
    ["// the API lane's to own.", 'a lane'],
    ["  // chosen a date. L4's `SuccessorRequest` still takes the instant.", 'a lane id'],
    ['// The runtime surface L3 wires onto the command registry.', 'a lane id'],
    [' * which prefix it was on (L5-PROOFS handback, "Defects" 4).', 'a review or proof record'],
    [' * (REVIEW-AGENT-BOUNDARY d58b869 N1).', 'a review or proof record'],
    ['// Ported from `ops-astro-t1-draft@60f2009 apps/api/app.ts`.', 'an earlier draft'],
    ['   * This comment said it wrote none.', 'an earlier draft'],
    [
      '  // left its lease live, because the old handler wrote only the timestamp.',
      'a story of earlier handling',
    ],
    [
      ' * It was once derived, then written by hand, because a test comparing the two',
      'a story of earlier handling',
    ],
    [
      '  // F4. A revocation is also one of the recorded authority-loss transitions.',
      'a numbered finding',
    ],
    [' * on the work whose claim it was (IDENT-AUDIT red 3).', 'a review or proof record'],
    ['    // the answer to a question it never put (I14-SEAM U1).', 'a review or proof record'],
  ])('refuses %s', (comment, citation) => {
    expect(cites(comment)).toBe(citation);
  });

  it.each([
    '// EX-01. A person picks up, renews and hands back as themselves.',
    ' * its settings (`tasks-trash.ts`, SPEC:319 and C12-5 Q46), so a body naming',
    "// Ruling 2 of dd30aa8: `lineageId` is the caller's.",
    ' * G06: the clock is read after the locks, not `now()`.',
    ' * R1. `locks` is required, not advisory.',
    '  /** Record, or forget, the draft save whose outcome is unknown. */',
    "/** Dollars as the server's minor units, rounded rather than truncated. */",
    ' * The grant key is business and token together; FNV-1a over it tells one',
    '// A handback names a lease rather than a task.',
    ' * prove abandonment (case L10), and the restore leaves a record whose parent',
    '  // Page size is bounded, not optional (E19:363), and the evidence renderer is G07.',
    '  /** The old lease is fenced out by the new fence rather than deleted. */',
    ' * stamp is a projection of the current state; the evidence that the task was once complete',
  ])('keeps %s', (comment) => {
    expect(cites(comment)).toBeUndefined();
  });

  it('reads line, block, JSX, trailing and SQL comments, and not strings or regexes', () => {
    const source = [
      "const lane = 'lane';// the row's own key",
      'const n = 1; /*',
      ' * a thermo review',
      ' */',
      'const view = <div>{/* Sol 6 */}</div>;',
      "const url = 'https://example.test/a//b /* a string */';",
      'const query = sql`select id from tasks',
      '  -- a trashed task is not handed out',
      '  where deleted_at is null`;',
      'const pattern = /\\/\\//u;',
    ].join('\n');
    const { lines, errors } = readComments(source);
    expect(errors).toEqual([]);
    expect(lines.map(({ line }) => line)).toEqual([1, 2, 3, 4, 5, 8]);
    expect(lines[0]?.comment).toBe("// the row's own key");
  });

  it('reads a phrase that wraps from one comment line to the next', () => {
    const source = [
      '// the read is refused, which is the case this screen used',
      '// to be in permanently.',
      'const a = 1;',
      '// a separate passage',
    ].join('\n');
    const read = passages(commentLines(source));
    expect(read.map(({ line }) => line)).toEqual([1, 4]);
    expect(cites(read[0]?.comment ?? '')).toBe('a story of earlier handling');
  });

  it.each([
    ['a tab-indented line comment', '\t//\tSol 6 SURFACE-1'],
    ['CRLF line endings', 'const a = 1;\r\n// final review R1 #20\r\nconst b = 2;'],
    ['a byte-order mark', '\uFEFF// thermo review b483399'],
    ['a comment inside a template expression', 'const s = `a ${/* Sol 6 */ 1} b`;'],
    ['a JSX comment nested in markup', 'const v = <div><span>{/* lane L4 */}</span></div>;'],
    ['a lower-case reviewer name', '// as sol asked'],
    ['a tab inside a SQL comment', 'const q = sql`select 1\n\t--\tF4. revoked\n`;'],
  ])('reads %s', (_, source) => {
    const read = passages(commentLines(source));
    expect(read.some(({ comment }) => cites(comment) !== undefined)).toBe(true);
  });

  it.each([
    ['a citation inside a string', "const s = '// Sol 6 AUTHORITY-4';"],
    ['a citation inside a template', 'const s = `/* thermo review */`;'],
    ['a citation inside a regex', 'const r = /Sol 6|thermo/u;'],
  ])('does not read %s', (_, source) => {
    expect(commentLines(source)).toEqual([]);
  });

  it('reads a renamed script, and refuses a format it has no reader for', () => {
    expect(commentLines('// Sol 6', 'x.cjs')).toHaveLength(1);
    expect(commentLines('/* lane L4 */', 'x.cts')).toHaveLength(1);
    expect(readComments('-- Sol 6', 'x.sql').errors).toHaveLength(1);
    expect(readComments('-- Sol 6', 'Makefile').errors).toHaveLength(1);
  });

  it('reads stylesheet and HTML comments across lines', () => {
    const css = 'a { color: red; } /* first line\n R2-RUNTIME-4 */';
    expect(commentLines(css, 'x.css').map(({ line }) => line)).toEqual([1, 2]);
    const html = '<p>x</p>\n<!--\nlane L4\n-->';
    expect(commentLines(html, 'x.html').map(({ line }) => line)).toEqual([2, 3, 4]);
  });

  it('holds over every comment in packages/ and apps/', () => {
    // Mode and path of every tracked file, so a symlink is refused rather than
    // read through, and a file in a format with no reader fails instead of
    // being skipped by its extension.
    const entries = execFileSync('git', ['ls-files', '-s', 'packages', 'apps'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .map((entry) => ({ mode: entry.split(' ')[0], file: entry.slice(entry.indexOf('\t') + 1) }));
    expect(entries.length).toBeGreaterThan(100);
    const found: string[] = [];
    const unread: string[] = entries
      .filter(({ mode }) => mode === '120000')
      .map(({ file }) => `${file} is a symlink`);
    const files = entries
      .filter(({ mode }) => mode !== '120000')
      .map(({ file }) => file)
      .filter((file) => !NO_COMMENTS.has(file.slice(file.lastIndexOf('.') + 1)));
    for (const file of files) {
      const { lines, errors } = readComments(readFileSync(new URL(file, root), 'utf8'), file);
      if (errors.length > 0) unread.push(`${file}: ${errors.length} unread`);
      for (const { line, comment } of passages(lines)) {
        const citation = citationIn(comment);
        if (citation !== undefined) {
          found.push(`${file}:${line} ${citation.label}: "${citation.words}"`);
        }
      }
    }
    expect(unread).toEqual([]);
    expect(found).toEqual([]);
  });

  it('Sol proof, criterion 4: rejects review citations in SQL comments', () => {
    const source = [
      'const query = `select id from records',
      '  -- Final review R1 #10: a trashed task is not handed out.',
      '  where deleted_at is null`;',
    ].join('\n');
    expect(commentLines(source).some(({ comment }) => cites(comment) !== undefined)).toBe(true);
  });

  it('Sol proof, criterion 4: rejects inline and multiline review comments', () => {
    const sources = [
      'const n = 1;// Final review R1 #10',
      ['const n = 1; /*', ' * Final review R1 #10', ' */'].join('\n'),
      ['<!--', 'Final review R1 #10', '-->'].join('\n'),
    ];
    expect(
      sources.map((source) =>
        commentLines(source).some(({ comment }) => cites(comment) !== undefined),
      ),
    ).toEqual([true, true, true]);
  });

  it('Sol proof, criterion 4: rejects SQL comments after query text', () => {
    const sources = [
      'const q = sql`select 1 -- Final review R1 #10\n`;',
      'const q = sql`select /* Final review R1 #10 */ 1`;',
    ];
    expect(
      sources.map((source) =>
        passages(commentLines(source)).some(({ comment }) => cites(comment) !== undefined),
      ),
    ).toEqual([true, true]);
  });

  it('Sol proof, criterion 5: product comments do not narrate earlier draft reviews', () => {
    const files = [
      'apps/api/app.ts',
      'packages/core-commands/src/reads/dispatch.ts',
      'packages/core-commands/src/commands/register-store.ts',
    ];
    const histories = files.flatMap((file) =>
      commentLines(readFileSync(new URL(file, root), 'utf8'))
        .filter(({ comment }) =>
          /\breview of the draft\b|\bused to say\b|\bcross-model review found\b/iu.test(comment),
        )
        .map(({ line, comment }) => `${file}:${line} ${comment.trim()}`),
    );
    expect(histories).toEqual([]);
  });

  it('Sol proof, criterion 5: remaining source comments state the current rule', () => {
    const files = [
      'packages/core-runtime/src/refusals.ts',
      'packages/core-runtime/src/only.ts',
      'packages/core-wire/src/surface.ts',
    ];
    const histories = files.flatMap((file) =>
      commentLines(readFileSync(new URL(file, root), 'utf8'))
        .filter(({ comment }) =>
          /\bwas claimed that way until\b|\bused to say\b|\bwas once derived\b/iu.test(comment),
        )
        .map(({ line, comment }) => `${file}:${line} ${comment.trim()}`),
    );
    expect(histories).toEqual([]);
  });

  it('Sol proof, criterion 5: comments describe the current API projection', () => {
    const source = readFileSync(
      new URL('packages/core-records/src/tasks/comments.ts', root),
      'utf8',
    );
    const stale = commentLines(source).filter(({ comment }) =>
      /\bnot yet projected through the API\b/iu.test(comment),
    );
    expect(stale).toEqual([]);
  });
});
