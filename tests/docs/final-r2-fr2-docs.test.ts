// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 2, lane FR2-DOCS: the doc statements round 2 found false
// at 3eb0cc1, held against the code they describe, so a doc line that drifts
// from it again fails here.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

/** Prose with its line breaks folded, so a phrase is found across a wrap. */
const folded = (text: string): string => text.replaceAll(/\s+/gu, ' ');

/** The table row of `API.md` whose first cell is `operation` and that names `route`. */
function apiRow(operation: string, route: string): string {
  const row = read('docs/local/API.md')
    .split('\n')
    .find((line) => line.startsWith(`| \`${operation}\``) && line.includes(`\`${route}\``));
  if (row === undefined) throw new Error(`API.md has no ${operation} row naming ${route}`);
  return row;
}

/** The body of the function `name` declares in `source`, to its closing brace. */
function bodyOf(source: string, name: string): string {
  const start = source.search(new RegExp(`function ${name}\\(`, 'u'));
  if (start < 0) throw new Error(`no function ${name}`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end < 0 ? undefined : end);
}

/** Every code a body answers with directly, by `refuse('X'` or `refuseCommand('X'`. */
const codesIn = (body: string): string[] => [
  ...new Set(
    [...body.matchAll(/refuse(?:Command)?\(\s*'([A-Z_]+)'/gu)].map((match) => match[1] ?? ''),
  ),
];

describe('API.md task.comment row (R2-AUTHORITY-37)', () => {
  it('names every code writeTaskComment answers', () => {
    const source = read('packages/core-records/src/commands/tasks-comment.ts');
    const codes = codesIn(bodyOf(source, 'writeTaskComment'));
    expect(codes).toEqual(
      expect.arrayContaining(['AUDIENCE_NOT_PERMITTED', 'FIELD_VALUE_INVALID']),
    );
    // The two helpers it calls answer these.
    expect(source).toContain('refuseNotFound()');
    expect(source).toContain('refuseUnlanded(on.declaration)');
    const row = apiRow('task.comment', '/task/comment');
    for (const code of [...codes, 'NOT_FOUND', 'DEPENDENCY_NOT_LANDED']) {
      expect(row, code).toContain(`\`${code}\``);
    }
  });
});

describe('API.md on the agent comment audience (R2-SURFACE-39)', () => {
  it('records internal-only as Nathan ruling, not a choice awaiting confirmation', () => {
    const api = folded(read('docs/local/API.md'));
    for (const sentence of api.split(/(?<=\.) /u)) {
      if (/await[s]? root or owner confirmation/u.test(sentence)) {
        expect(sentence).not.toMatch(/audience|comment/u);
      }
    }
    expect(api).toMatch(
      /An agent comments in the `internal` audience only\.\*\*[\s\S]{0,400}?Nathan's ruling \(OWNER-CARD section 6\)/u,
    );
  });
});

/**
 * Each `local-seed.mjs` line cite in the docs, found as the `index`th backticked
 * range after `after`, and a line of the seed it has to cover.
 */
const SEED_CITES: readonly {
  readonly doc: string;
  readonly after: string;
  readonly index: number;
  readonly anchor: string;
}[] = [
  {
    doc: 'AUTHORITY.md',
    after: 'creates its GoTrue user',
    index: 0,
    anchor: 'function ensureExternalEntry(',
  },
  {
    doc: 'AUTHORITY.md',
    after: 'creates its GoTrue user',
    index: 0,
    anchor: 'async function seedExternalUser(',
  },
  {
    doc: 'AUTHORITY.md',
    after: 'creates its GoTrue user',
    index: 1,
    anchor: 'ensureExternalEntry(users)',
  },
  {
    doc: 'AUTHORITY.md',
    after: 'no membership and no business grant',
    index: 0,
    anchor: 'external: [],',
  },
  {
    doc: 'AUTHORITY.md',
    after: 'no membership and no business grant',
    index: 1,
    anchor: "member.role === 'external'",
  },
  {
    doc: 'AUTHORITY.md',
    after: 'naming a task',
    index: 0,
    anchor: 'async function shareWithExternal(',
  },
  {
    doc: 'AUTHORITY.md',
    after: 'naming a task',
    index: 1,
    anchor: "process.env['LOCAL_SEED_SHARE_TASK']",
  },
  {
    doc: 'RUNTIME.md',
    after: 'never rewrites it',
    index: 0,
    anchor: 'ensureCredentialKeyFile(credentialFile)',
  },
  { doc: 'PROOFS.md', after: 'the admin `task:decide`', index: 0, anchor: "['task', 'decide']," },
];

describe('scripts/local-seed.mjs line cites (R2-SURFACE-44)', () => {
  const seed = read('scripts/local-seed.mjs').split('\n');

  it.each(SEED_CITES)('$doc after "$after" covers $anchor', ({ doc, after, index, anchor }) => {
    const text = folded(read(`docs/local/${doc}`));
    const at = text.indexOf(after);
    expect(at, `"${after}" in ${doc}`).toBeGreaterThanOrEqual(0);
    const ranges = [
      ...text.slice(at).matchAll(/`(?:(?:scripts\/)?local-seed\.mjs)?:(\d+)(?:-(\d+))?`/gu),
    ];
    const cite = ranges[index];
    expect(cite, `cite ${String(index)} after "${after}"`).toBeDefined();
    const from = Number(cite?.[1]);
    const to = Number(cite?.[2] ?? cite?.[1]);
    const line = seed.findIndex((source) => source.includes(anchor)) + 1;
    expect(line, anchor).toBeGreaterThan(0);
    expect(
      line,
      `${anchor} at :${String(line)}, cited :${String(from)}-${String(to)}`,
    ).toBeGreaterThanOrEqual(from);
    expect(
      line,
      `${anchor} at :${String(line)}, cited :${String(from)}-${String(to)}`,
    ).toBeLessThanOrEqual(to);
  });
});

describe('API.md task.create row (R2-THERMO-62)', () => {
  it('gives its body and every code createTask and its placement answer', () => {
    const row = apiRow('task.create', '/task/create');
    const requests = read('packages/core-records/src/commands/requests.ts');
    const shape = requests.slice(requests.indexOf("command: 'task.create'"));
    for (const operand of ['fields', 'parentId', 'board', 'boardSection', 'stateKey']) {
      expect(shape.slice(0, shape.indexOf('} & Envelope'))).toContain(`readonly ${operand}`);
      expect(row, operand).toContain(`\`${operand}`);
    }
    const write = read('packages/core-records/src/commands/tasks-write.ts');
    const codes = new Set([
      ...codesIn(bodyOf(write, 'createTask')),
      ...codesIn(bodyOf(write, 'refuseSpoof')),
      ...codesIn(bodyOf(read('packages/core-records/src/tasks/placement.ts'), 'planTaskPlacement')),
      ...codesIn(bodyOf(read('packages/core-records/src/records/fields.ts'), 'refuseGenericWrite')),
      // `refuseCreateOperands` and `refuseWrongValueType` both answer this.
      'FIELD_VALUE_INVALID',
    ]);
    expect([...codes]).toEqual(
      expect.arrayContaining([
        'SOURCE_SPOOFED',
        'PARENT_TRASHED',
        'PLACEMENT_IS_DERIVED',
        'NOT_FOUND',
      ]),
    );
    // The table lists what each write adds to the refusals its intro names for
    // every write, before "a write with a target".
    const api = folded(read('docs/local/API.md'));
    const intro = api.slice(
      api.indexOf("Every write also answers the envelope's own refusals"),
      api.indexOf('and a write with a target'),
    );
    const everyWrite = new Set([...intro.matchAll(/`([A-Z_]+)`/gu)].map((match) => match[1]));
    for (const code of codes) {
      if (!everyWrite.has(code)) expect(row, code).toContain(`\`${code}\``);
    }
  });
});
