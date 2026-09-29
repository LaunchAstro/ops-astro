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
  ['a Sol review', /\bSol\b|\bSOL-[A-Z0-9]/u],
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
    /\bused to\b|\bwas once\b|\bthat way until\b|\bcame off\b|\bleft this list\b|\bthe old handler\b|\bis what found\b/iu,
  ],
];

/** Which citation a comment makes, or undefined. */
const cites = (comment: string): string | undefined =>
  CITATIONS.find(([, pattern]) => pattern.test(comment))?.[0];

type CommentLine = { readonly line: number; readonly comment: string };

const LANGS = { ts: 'ts', mts: 'ts', tsx: 'tsx', js: 'js', mjs: 'js' } as const;

/**
 * Every comment in `text`, one entry per source line it covers. A script's
 * comments come from the parser (vite's `parseSync`, which is oxc), so a
 * `//` or `/*` inside a string, a template or a regex is never read, and a
 * comment after code, with or without a space, always is. Two kinds the
 * parser does not report are read by pattern: a SQL `--` line, which sits
 * inside a query template, and an HTML comment. A stylesheet's comments are
 * its block comments. `errors` is what the parser could not read.
 */
function readComments(
  text: string,
  file = 'source.tsx',
): { readonly lines: CommentLine[]; readonly errors: readonly unknown[] } {
  const extension = file.slice(file.lastIndexOf('.') + 1);
  const spans: (readonly [number, number])[] = [];
  let errors: readonly unknown[] = [];
  if (extension in LANGS) {
    const parsed = parseSync(file, text, { lang: LANGS[extension as keyof typeof LANGS] });
    errors = parsed.errors;
    for (const { start, end } of parsed.comments) spans.push([start, end]);
    for (const sql of text.matchAll(/^[ \t]*--\s.*$/gmu)) {
      spans.push([sql.index, sql.index + sql[0].length]);
    }
  } else {
    for (const block of text.matchAll(/\/\*[\s\S]*?\*\//gu)) {
      spans.push([block.index, block.index + block[0].length]);
    }
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

  it('reads stylesheet and HTML comments across lines', () => {
    const css = 'a { color: red; } /* first line\n R2-RUNTIME-4 */';
    expect(commentLines(css, 'x.css').map(({ line }) => line)).toEqual([1, 2]);
    const html = '<p>x</p>\n<!--\nlane L4\n-->';
    expect(commentLines(html, 'x.html').map(({ line }) => line)).toEqual([2, 3, 4]);
  });

  it('holds over every comment in packages/ and apps/', () => {
    const files = execFileSync('git', ['ls-files', 'packages', 'apps'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((file) => /\.(?:ts|tsx|mts|mjs|js|css|html)$/u.test(file));
    expect(files.length).toBeGreaterThan(100);
    const found: string[] = [];
    const unread: string[] = [];
    for (const file of files) {
      const { lines, errors } = readComments(readFileSync(new URL(file, root), 'utf8'), file);
      if (errors.length > 0) unread.push(file);
      for (const { line, comment } of lines) {
        const citation = cites(comment);
        if (citation !== undefined) found.push(`${file}:${line} ${citation}: ${comment.trim()}`);
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
});
