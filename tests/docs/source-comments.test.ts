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
 * parser does not report are read here: SQL comments inside query text
 * (`queryComments`), and an HTML comment, by pattern. A stylesheet's comments are
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
    spans.push(...queryComments(parsed.program));
  } else if (STYLES.has(extension)) {
    spans.push(...blockComments(text));
  } else {
    errors = [`${file} is not a format this check reads`];
  }
  spans.push(...htmlComments(text));
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
      .replace(/\s*(?:\*\/|--!?>)\s*$/u, '')
      .trim();
    const current = found.at(-1);
    if (current !== undefined && line === previous + 1) current.comment += ` ${words}`;
    else found.push({ line, comment: words });
    previous = line;
  }
  return found;
}

/**
 * A dollar-quote tag as Postgres reads one: `$$`, or `$` and an identifier
 * (a letter or underscore, then letters, digits or underscores) and `$`. So
 * `$body1$` opens a quoted value, and `$1` is a parameter, not a tag.
 */
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u;

/** A stylesheet's block comments; one left open runs to the end of the file. */
function blockComments(text: string): (readonly [number, number])[] {
  const spans: (readonly [number, number])[] = [];
  let open = text.indexOf('/*');
  while (open >= 0) {
    const close = text.indexOf('*/', open + 2);
    const end = close < 0 ? text.length : close + 2;
    spans.push([open, end]);
    open = text.indexOf('/*', end);
  }
  return spans;
}

/**
 * HTML comments, ended as the HTML parser ends them: at `-->` or `--!>`,
 * at once for the abrupt `<!-->` and `<!--->`, and at the end of the text
 * when one is never closed.
 */
function htmlComments(text: string): (readonly [number, number])[] {
  const spans: (readonly [number, number])[] = [];
  let open = text.indexOf('<!--');
  while (open >= 0) {
    const body = open + 4;
    let end = text.length;
    if (text.startsWith('>', body)) end = body + 1;
    else if (text.startsWith('->', body)) end = body + 2;
    else {
      for (const close of ['-->', '--!>']) {
        const at = text.indexOf(close, body);
        if (at >= 0) end = Math.min(end, at + close.length);
      }
    }
    spans.push([open, end]);
    open = text.indexOf('<!--', end);
  }
  return spans;
}

/**
 * The comments in one piece of SQL, as offsets into the file: `--` to the end
 * of its line anywhere in the text, and `/*` to its matching close, nested as
 * Postgres nests them. A quoted value (`'...'`, a doubled quote inside it, an
 * `E'...'` backslash escape), a quoted identifier (`"..."`) and a
 * dollar-quoted body (`$tag$...$tag$`) are skipped whole, so a `--` or `/*`
 * inside one is data, not a comment.
 */
function sqlComments(sql: string, offset: number): (readonly [number, number])[] {
  const spans: (readonly [number, number])[] = [];
  let at = 0;
  while (at < sql.length) {
    const char = sql[at];
    if (char === "'" || char === '"') {
      const escapes = char === "'" && /[Ee]/u.test(sql[at - 1] ?? '');
      at += 1;
      while (at < sql.length) {
        if (escapes && sql[at] === '\\') at += 2;
        else if (sql[at] === char && sql[at + 1] === char) at += 2;
        else if (sql[at] === char) break;
        else at += 1;
      }
      at += 1;
    } else if (char === '$' && DOLLAR_TAG.test(sql.slice(at))) {
      const tag = DOLLAR_TAG.exec(sql.slice(at))?.[0] ?? '$$';
      const close = sql.indexOf(tag, at + tag.length);
      at = close < 0 ? sql.length : close + tag.length;
    } else if (sql.startsWith('--', at)) {
      const newline = sql.indexOf('\n', at);
      const end = newline < 0 ? sql.length : newline;
      spans.push([offset + at, offset + end]);
      at = end;
    } else if (sql.startsWith('/*', at)) {
      let depth = 1;
      let end = at + 2;
      while (end < sql.length && depth > 0) {
        if (sql.startsWith('/*', end)) [depth, end] = [depth + 1, end + 2];
        else if (sql.startsWith('*/', end)) [depth, end] = [depth - 1, end + 2];
        else end += 1;
      }
      spans.push([offset + at, offset + end]);
      at = end;
    } else {
      at += 1;
    }
  }
  return spans;
}

/** A string literal's value that reads as a SQL statement. */
const SQL_STATEMENT =
  /^\s*(?:select|insert|update|delete|merge|with|values|table|set|reset|show|lock|create|alter|drop|grant|revoke|begin|commit|rollback|savepoint|release|truncate|comment|explain|analyze|vacuum|copy|call|do|notify|listen)\b/iu;

/**
 * Whether a string's value reads as a SQL statement once its comments are
 * set aside, so a query that opens with a `--` or `/*` comment still counts.
 */
function readsAsSql(value: string): boolean {
  let statement = value;
  for (const [start, end] of sqlComments(value, 0).toReversed()) {
    statement = `${statement.slice(0, start)}${' '.repeat(end - start)}${statement.slice(end)}`;
  }
  return SQL_STATEMENT.test(statement);
}

/**
 * SQL comments in a parsed script: every template literal's text (a query
 * template, tagged or not, is one), and every string literal that reads as a
 * SQL statement. Each piece of text is lexed on its own, between the
 * template's `${...}` holes.
 */
function queryComments(program: unknown): (readonly [number, number])[] {
  const spans: (readonly [number, number])[] = [];
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    const each = node as { type?: unknown; start?: number; value?: unknown; raw?: unknown };
    if (each.type === 'TemplateElement' && typeof each.start === 'number') {
      const { raw } = each.value as { raw: string };
      spans.push(...sqlComments(raw, each.start + 1));
    } else if (
      each.type === 'Literal' &&
      typeof each.value === 'string' &&
      typeof each.raw === 'string' &&
      typeof each.start === 'number' &&
      readsAsSql(each.value)
    ) {
      spans.push(...sqlComments(each.raw.slice(1, -1), each.start + 1));
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(program);
  return spans;
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
    ['a SQL comment after a tab', 'const q = sql`select 1\t--\tSol 6`;'],
    ['a nested SQL block comment', 'const q = sql`select /* outer /* inner */ Sol 6 */ 1`;'],
    ['an upper-case SQL comment', 'const q = sql`SELECT 1 -- FINAL REVIEW R1 #10`;'],
    ['a SQL comment after a quoted dash pair', "const q = sql`select '--', 1 -- Sol 6`;"],
    ['a SQL comment after a doubled quote', "const q = sql`select 'it''s' -- lane L4`;"],
    ['a SQL comment after an E-string escape', "const q = sql`select E'it\\'s' -- thermo`;"],
    ['a SQL comment after a dollar-quoted body', 'const q = sql`select $$ -- data $$ -- thermo`;'],
    ['a SQL comment after an interpolation', 'const q = sql`select ${columns} -- Sol 6`;'],
    ['a SQL comment in a plain string query', "tx.query('select 1 -- Sol 6');"],
    ['a leading SQL block comment in a plain string', "tx.query('/* thermo */ select 1');"],
    [
      'a SQL comment after a digit-bearing dollar body',
      'const q = sql`select $b1$ -- data $b1$ -- thermo`;',
    ],
    ['a SQL comment after parameter placeholders', 'const q = sql`select $1, $2 -- Sol 6`;'],
  ])('reads %s', (_, source) => {
    const read = passages(commentLines(source));
    expect(read.some(({ comment }) => cites(comment) !== undefined)).toBe(true);
  });

  it.each([
    ['a citation inside a string', "const s = '// Sol 6 AUTHORITY-4';"],
    [
      'a dash pair or block inside quoted SQL values',
      'const q = sql`select \'-- Sol 6\' as a, "/* thermo */" as b`;',
    ],
    ['a dollar-quoted SQL body', 'const q = sql`select $body$ -- Sol 6 $body$`;'],
    ['an escaped quote in a SQL E-string', "const q = sql`select E'it\\'s -- Sol 6'`;"],
    ['a doubled quote in a SQL value', "const q = sql`select 'it''s -- Sol 6'`;"],
    ['a flag in a plain string that is not SQL', "const flag = '--lane L4';"],
    [
      'a dollar body whose tag has a digit and an underscore',
      'const q = sql`select $a_2$ -- Sol 6 $a_2$`;',
    ],
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

  it.each([
    ['an HTML comment ended by --!>', '<!-- Sol 6 --!>\n<p>text</p>', 'x.html', [1]],
    ['an HTML comment ended by -->', '<!-- Sol 6 -->\n<p>text</p>', 'x.html', [1]],
    ['an unterminated HTML comment', '<p>text</p>\n<!-- Sol 6\nmore', 'x.html', [2, 3]],
    ['an abrupt <!--> and not the text after it', '<!-->\n<p>Sol 6</p>', 'x.html', [1]],
    ['an abrupt <!---> and not the text after it', '<!--->\n<p>Sol 6</p>', 'x.html', [1]],
    ['an unterminated stylesheet block', 'a { color: red; }\n/* Sol 6\nmore', 'x.css', [2, 3]],
    ['an unterminated SQL block', 'const q = sql`select 1\n/* Sol 6\n`;', 'x.ts', [2, 3]],
  ])('reads %s, and only it', (_, source, file, lines) => {
    expect(commentLines(source, file).map(({ line }) => line)).toEqual(lines);
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

  it('Sol proof, criterion 4: reads leading SQL comments and preserves numeric dollar tags', () => {
    const leading = "tx.query('-- Final review R1 #10\\nselect 1');";
    const quoted = 'const q = sql`select $body1$ -- Sol 6 $body1$`;';
    const unterminated = 'const q = sql`select /* Sol 6`;';
    expect([
      passages(commentLines(leading)).some(({ comment }) => cites(comment) !== undefined),
      commentLines(quoted).length === 0,
      passages(commentLines(unterminated)).some(({ comment }) => cites(comment) !== undefined),
    ]).toEqual([true, true, true]);
  });

  it('Sol proof, criterion 4: preserves non-ASCII dollar-quoted SQL values', () => {
    const source = 'const q = sql`select $é2$ -- Sol 6 $é2$`;';
    expect(commentLines(source)).toEqual([]);
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
