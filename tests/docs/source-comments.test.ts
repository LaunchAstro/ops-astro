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
    /REVIEW-[A-Z]|-PROOFS\b|\bDB-PROOF|\bFG-[A-Z]-\d+|\bCQ-\d+\b|\bTR-[A-Z]+-/u,
  ],
  ['a lane id', /\bL[1-9]\b/u],
  ['an earlier draft', /t1-draft|\bearlier draft\b|\bthis comment said\b/iu],
];

/** Which citation a comment makes, or undefined. */
const cites = (comment: string): string | undefined =>
  CITATIONS.find(([, pattern]) => pattern.test(comment))?.[0];

/**
 * The comment text on each line of `text`, with its line number: a `//`
 * comment, a line inside or opening a block comment (`/*` in TypeScript and
 * CSS, `{/*` in JSX), an HTML comment, or a SQL `--` line inside a query
 * string. Code before a trailing `//` is not read, so a string that happens to
 * hold a word in the set is not a comment.
 */
function commentLines(text: string): { readonly line: number; readonly comment: string }[] {
  const found: { line: number; comment: string }[] = [];
  let inBlock = false;
  for (const [index, line] of text.split('\n').entries()) {
    let comment: string | undefined;
    if (inBlock) {
      comment = line;
      if (line.includes('*/')) inBlock = false;
    } else if (/^\s*\/\//u.test(line)) {
      comment = line;
    } else if (/^\s*--\s/u.test(line)) {
      comment = line;
    } else if (/^\s*\{?\/\*/u.test(line)) {
      comment = line;
      if (!line.includes('*/')) inBlock = true;
    } else if (/\s\/\/\s/u.test(line)) {
      comment = line.slice(line.search(/\s\/\/\s/u));
    } else if (/\/\*.*\*\//u.test(line)) {
      comment = line.slice(line.indexOf('/*'));
    } else if (line.includes('<!--')) {
      comment = line.slice(line.indexOf('<!--'));
    }
    if (comment !== undefined) found.push({ line: index + 1, comment });
  }
  return found;
}

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
  ])('keeps %s', (comment) => {
    expect(cites(comment)).toBeUndefined();
  });

  it('reads line, block, JSX, trailing and SQL comments, and not code', () => {
    const source = [
      "const lane = 'lane'; // the row's own key",
      '/**',
      ' * a thermo review',
      ' */',
      '{/* Sol 6 */}',
      'plain text after the block has closed',
      "fetch('https://example.test/a//b');",
      '  sql`select id from tasks',
      '       -- a trashed task is not handed out',
      '       where deleted_at is null`; i--;',
    ].join('\n');
    expect(commentLines(source).map(({ line }) => line)).toEqual([1, 2, 3, 4, 5, 9]);
    expect(commentLines(source)[0]?.comment).toBe(" // the row's own key");
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
    for (const file of files) {
      for (const { line, comment } of commentLines(readFileSync(new URL(file, root), 'utf8'))) {
        const citation = cites(comment);
        if (citation !== undefined) found.push(`${file}:${line} ${citation}: ${comment.trim()}`);
      }
    }
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

  it('Sol proof, criterion 4: rejects lane identifiers in source comments', () => {
    const successor = readFileSync(
      new URL('packages/core-commands/src/commands/successor.ts', root),
      'utf8',
    );
    const lane = commentLines(successor).find(({ comment }) =>
      comment.includes("L4's `SuccessorRequest`"),
    );
    expect(lane).toBeDefined();
    expect(cites(lane?.comment ?? '')).toBeDefined();
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
});
