// SPDX-License-Identifier: AGPL-3.0-only
//
// Test files are named by what they prove, so a reader finds them by
// behaviour without knowing when each was written. A review id in a file
// name or a test title points at a record a reader of this repository cannot
// open. Ticket ids stay: a ticket's acceptance names its tests after its
// checklist lines. Product source holds no module that only tests import.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import { gitHistory } from '../support/git-history.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The files under `paths`: git's list in a clone, and the tree itself in a
 * source export, which has no index to ask.
 */
function tracked(...paths: string[]): string[] {
  if (gitHistory(root) !== 'none') {
    return execFileSync('git', ['ls-files', ...paths], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  }
  return paths
    .flatMap((path) =>
      readdirSync(join(root, path), { recursive: true, encoding: 'utf8' }).map((file) =>
        join(path, file),
      ),
    )
    .filter((file) => !file.split('/').includes('node_modules') && /\.[a-z]+$/u.test(file))
    .toSorted();
}

/**
 * A file name that files a test by the review round that found a defect. A
 * bare `r4` is the contract's rule R4, as `i10` is I10, and is kept.
 */
const ROUND_NAME = /final-r\d|review-fix|(?:^|[-_/])(?:fr\d+|round-?\d+)(?:[-_.]|$)|(?:^|\/)sol-/iu;

/** A review id in a test title, each with an example of what it refuses. */
const REVIEW_IDS: readonly (readonly [string, RegExp])[] = [
  ['a final review round', /final[- ]r\d|\bfinal review\b|\breview round\b|\bround \d+\b/iu],
  ['a review lane id', /\bFR\d+(?:-[A-Z]+)*\b|\bPIR\d/iu],
  ['a numbered review finding', /\bR\d+-[A-Z]+-\d+|\b(?:RUNTIME|AUTHORITY|SURFACE)-\d+\b/iu],
  ['a thermo review', /thermo/iu],
  ['a Sol review', /\bSol\b|\bSOL-[A-Z0-9]/iu],
  ['a recheck finding code', /\b(?:NNA|NA|NB|NC)\d+\b/iu],
  ['a finding number', /(?:^|\()#\d+\b/u],
  ['a gate finding', /\bFG-[A-Z]-\d+/iu],
];

const citesReview = (title: string): string | undefined =>
  REVIEW_IDS.find(([, pattern]) => pattern.test(title))?.[0];

type Node = Record<string, unknown>;

/** The name a call chain starts from: `it` for `it`, `it.each([...])` and `describe.skipIf(x)`. */
function chainRoot(node: unknown): string | undefined {
  const n = node as Node | null;
  if (n?.['type'] === 'Identifier') return n['name'] as string;
  if (n?.['type'] === 'MemberExpression') {
    const property = (n['property'] as Node)['name'];
    return MODIFIERS.has(property as string) ? chainRoot(n['object']) : undefined;
  }
  if (n?.['type'] === 'CallExpression') return chainRoot(n['callee']);
  return undefined;
}

/**
 * A string literal or template's text, with each `${...}` kept as written, and
 * the text of literals joined with `+`.
 */
function literalText(node: unknown): string | undefined {
  const n = node as Node | undefined;
  if (n?.['type'] === 'Literal' && typeof n['value'] === 'string') return n['value'];
  if (n?.['type'] === 'BinaryExpression' && n['operator'] === '+') {
    const left = literalText(n['left']);
    const right = literalText(n['right']);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (n?.['type'] === 'TemplateLiteral') {
    return (n['quasis'] as Node[])
      .map((quasi) => (quasi['value'] as { cooked: string }).cooked)
      .join('${}');
  }
  return undefined;
}

/**
 * Every `describe`, `it` or `test` title in `text`, with its line, read from
 * the parsed calls: a string that only holds `it('...` is not a call.
 */
function titles(file: string, text: string): { readonly line: number; readonly title: string }[] {
  const program = parse(file, text);
  // `it`, `test`, `describe` and `suite`, under whatever name the file
  // imported them from vitest.
  const titled = new Set(UNIMPORTED);
  for (const statement of program['body'] as Node[]) {
    if (statement['type'] !== 'ImportDeclaration') continue;
    const from = (statement['source'] as Node)['value'];
    if (from !== 'vitest' && from !== 'node:test') continue;
    for (const specifier of statement['specifiers'] as Node[]) {
      const local = (specifier['local'] as Node)['name'] as string;
      const imported =
        specifier['type'] === 'ImportDefaultSpecifier'
          ? 'test'
          : (specifier['imported'] as Node | undefined)?.['name'];
      if (typeof imported === 'string' && TITLED.has(imported)) titled.add(local);
    }
  }
  const found: { line: number; title: string }[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const n = node as Node;
    if (n['type'] === 'CallExpression' && titled.has(chainRoot(n['callee']) ?? '')) {
      const title = literalText((n['arguments'] as unknown[])[0]);
      if (title !== undefined) {
        found.push({ line: text.slice(0, n['start'] as number).split('\n').length, title });
      }
    }
    for (const value of Object.values(n)) visit(value);
  };
  visit(program);
  return found;
}

/** What vitest and node:test call a titled block, and what the file names it by default. */
const TITLED: ReadonlySet<string> = new Set(['describe', 'it', 'suite', 'test']);
const UNIMPORTED: ReadonlySet<string> = new Set(['describe', 'it', 'test']);

/** The modifiers a titled call is chained through: `it.each`, `describe.skipIf(x)`. */
const MODIFIERS: ReadonlySet<string> = new Set([
  'concurrent',
  'each',
  'fails',
  'for',
  'only',
  'runIf',
  'sequential',
  'shuffle',
  'skip',
  'skipIf',
  'todo',
]);

/** The parsed program; a file that does not parse fails the check rather than passing it. */
function parse(file: string, text: string): Node {
  const lang = file.endsWith('.tsx') ? 'tsx' : /\.[cm]?js$/u.test(file) ? 'js' : 'ts';
  const parsed = parseSync(file, text, { lang });
  if (parsed.errors.length > 0) throw new Error(`${file} does not parse`);
  return parsed.program as unknown as Node;
}

const testFiles = (): string[] =>
  tracked('tests', 'packages', 'apps').filter((file) => /\.test\.(?:ts|tsx|mjs)$/u.test(file));

describe('test files named by what they prove', () => {
  it.each([
    ['tests/runtime/review-fixes.test.ts', true],
    ['tests/commands/final-r2-place.test.ts', true],
    ['tests/api/sol-cq6-review.test.ts', true],
    ['tests/docs/fr2-docs.test.ts', true],
    ['tests/runtime/round-3.test.ts', true],
    ['tests/commands/placement-operands.test.ts', false],
    ['tests/ci/review-evidence-cases.sh', false],
    ['tests/runtime/successor-bounds-edge.test.ts', false],
    ['tests/api/cq-7.test.ts', false],
    ['tests/browser/r4-shared-page.mjs', false],
  ])('reads %s as filed by when it was found: %s', (file, round) => {
    expect(ROUND_NAME.test(file)).toBe(round);
  });

  it.each([
    [
      'R2-RUNTIME-4 a decide grant that lapses while the decision waits',
      'a numbered review finding',
    ],
    ['final review round 1: trash, purge and cancel', 'a final review round'],
    ['FR1-JSONB: unstorable bodies', 'a review lane id'],
    ['R1-THERMO-13: task.reparent needs a parentId', 'a numbered review finding'],
    ['Sol proof, criterion 6: an agent command refuses', 'a Sol review'],
    ['SOL-R3-1: an over-ceiling total admitted at 0028', 'a Sol review'],
    ['agent recordId shape (NNA1)', 'a recheck finding code'],
    ['#27: a cancelled lineage is not offered for a decision', 'a finding number'],
    ['AUTHORITY.md on task.comment (#21, #42)', 'a finding number'],
    ['reserve against a cap it cannot read (thermo O2)', 'a thermo review'],
  ])('refuses the title %s', (title, citation) => {
    expect(citesReview(title)).toBe(citation);
  });

  it.each([
    'CQ-7 isolation: business to business',
    'R4 and the two reads that describe a business',
    'the %s row holds %s',
    'a round-trip keeps the rank',
    'task.decide versionId absent or not a string',
  ])('keeps the title %s', (title) => {
    expect(citesReview(title)).toBeUndefined();
  });
});

describe('test files named by what they prove', () => {
  it('reads a title after a string that holds a call', () => {
    const source = [
      'const tail = suite.slice(suite.indexOf("it(\'CQ-8 isolation:"));',
      "it('Sol proof, criterion 10: a guard', () => {});",
      'describe.skipIf(skip)(`on a ${kind} database`, () => {});',
    ].join('\n');
    expect(titles('a.test.ts', source)).toEqual([
      { line: 2, title: 'Sol proof, criterion 10: a guard' },
      { line: 3, title: 'on a ${} database' },
    ]);
  });

  it('reads a title however it is cased, joined or imported', () => {
    const source = [
      "import { it as check, describe as group, suite } from 'vitest';",
      "import probe from 'node:test';",
      "probe('FR2-JSONB: a node test', () => {});",
      "suite('thermo O2', () => {});",
      "check('sol proof, criterion 2: a guard', () => {});",
      "group('Sol ' + 'proof, criterion 4', () => {});",
      "check(`r2-runtime-4 ${'a'}`, () => {});",
    ].join('\n');
    const found = titles('a.test.ts', source);
    expect(found.map(({ line }) => line)).toEqual([3, 4, 5, 6, 7]);
    expect(found.map(({ title }) => citesReview(title))).toEqual([
      'a review lane id',
      'a thermo review',
      'a Sol review',
      'a Sol review',
      'a numbered review finding',
    ]);
  });
});

describe('test files named by what they prove', () => {
  it('no test file name contains final-r, review-fixes or a round number, and no test title cites a review id', () => {
    const files = testFiles();
    expect(files.length).toBeGreaterThan(200);
    const named = tracked('tests').filter((file) => ROUND_NAME.test(file));
    const cited: string[] = [];
    let seen = 0;
    for (const file of files) {
      for (const { line, title } of titles(file, readFileSync(join(root, file), 'utf8'))) {
        seen += 1;
        const citation = citesReview(title);
        if (citation !== undefined) cited.push(`${file}:${line} ${citation}: ${title}`);
      }
    }
    expect(seen).toBeGreaterThan(2000);
    expect({ named, cited }).toEqual({ named: [], cited: [] });
  });
});

/** Each workspace package's name, and the file its bare name resolves to. */
function packageEntries(): Map<string, string> {
  const entries = new Map<string, string>();
  for (const manifest of tracked('packages', 'apps').filter((file) =>
    /^(?:packages|apps)\/[^/]+\/package\.json$/u.test(file),
  )) {
    const { name, main } = JSON.parse(readFileSync(join(root, manifest), 'utf8')) as {
      name?: string;
      main?: string;
    };
    if (name !== undefined && main !== undefined) {
      entries.set(name, normalize(join(dirname(manifest), main)));
    }
  }
  return entries;
}

/**
 * The files `text` imports, resolved against `file`: `import` and `export ...
 * from` declarations and `import()` with a literal, by relative path or by a
 * workspace package's name. Read from the parsed program, so a comment or a
 * string that only looks like an import is not one.
 */
function importsOf(file: string, text: string, packages: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  const add = (source: unknown): void => {
    const spec = literalText(source);
    if (spec === undefined) return;
    if (spec.startsWith('./') || spec.startsWith('../')) {
      found.push(normalize(join(dirname(file), spec)));
    } else if (packages.has(spec)) {
      found.push(packages.get(spec) ?? spec);
    }
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const n = node as Node;
    if (
      n['type'] === 'ImportDeclaration' ||
      n['type'] === 'ExportAllDeclaration' ||
      n['type'] === 'ExportNamedDeclaration' ||
      n['type'] === 'ImportExpression'
    ) {
      add(n['source']);
    }
    for (const value of Object.values(n)) visit(value);
  };
  visit(parse(file, text));
  return found;
}

/**
 * Product files no product module imports yet, each with why it stays in
 * product source. Anything else a test imports and no product code does
 * belongs in `tests/`.
 */
const NO_PRODUCT_IMPORTER_YET = new Map([
  [
    'packages/core-commands/src/reads/conversation.ts',
    "MP-4-5's three detail levels of a task conversation, for the agent bundles (API-4) that call it",
  ],
  [
    'apps/api/function.ts',
    "the Vercel function entry, loaded by Vercel's Node.js runtime rather than imported",
  ],
  [
    'apps/worker/main.ts',
    'the worker process entry (`pnpm worker`), started by node rather than imported',
  ],
  [
    'packages/core-records/src/identity/identifier-resolution.ts',
    'kept, tested, for its named callers MP-8-6 and C48 (docs/current-decisions.md, 28 September 2026)',
  ],
  [
    'packages/core-records/src/records/conformance.ts',
    "the domain model's conformance proof, part of that protected component",
  ],
  [
    'packages/core-records/src/tasks/conformance.ts',
    "the task type's half of the domain model's conformance proof",
  ],
  [
    'packages/core-records/src/authority/index.ts',
    'the authority contract: the names a consumer may import, pinned in one place',
  ],
  [
    'packages/core-records/src/tenancy/privileges.ts',
    "the tenancy wrapper's default-deny conformance check, part of that protected component",
  ],
]);

const isCode = (file: string): boolean => /\.(?:ts|tsx|mts|mjs|js)$/u.test(file);
const isTest = (file: string): boolean =>
  file.startsWith('tests/') || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file);

describe('product source holds what the product uses', () => {
  it('counts an import only where the code makes one', () => {
    const source = [
      "// import { validateView } from './views.ts';",
      'const hint = "from \'./hint.ts\'";',
      "import { a } from './a.ts';",
      "export * from '../b.ts';",
      "const c = await import('./c.ts');",
      "import { Badge } from '@launchastro/ui';",
      "import { readFileSync } from 'node:fs';",
    ].join('\n');
    expect(
      importsOf(
        'packages/p/src/x.ts',
        source,
        new Map([['@launchastro/ui', 'packages/ui/src/index.ts']]),
      ),
    ).toEqual([
      'packages/p/src/a.ts',
      'packages/p/b.ts',
      'packages/p/src/c.ts',
      'packages/ui/src/index.ts',
    ]);
  });

  it('nothing in packages/ or apps/ is imported only by tests', () => {
    const product = tracked('packages', 'apps').filter((file) => isCode(file) && !isTest(file));
    const importers = new Map<string, { product: number; tests: number }>();
    const code = tracked('packages', 'apps', 'tests', 'scripts').filter((path) => isCode(path));
    const packages = packageEntries();
    for (const file of code) {
      const kind = isTest(file) ? 'tests' : 'product';
      for (const target of importsOf(file, readFileSync(join(root, file), 'utf8'), packages)) {
        const count = importers.get(target) ?? { product: 0, tests: 0 };
        count[kind] += 1;
        importers.set(target, count);
      }
    }
    const testOnly = product.filter((file) => {
      const count = importers.get(file);
      return count !== undefined && count.tests > 0 && count.product === 0;
    });
    expect(product.length).toBeGreaterThan(100);
    expect(testOnly.filter((file) => !NO_PRODUCT_IMPORTER_YET.has(file))).toEqual([]);
    // An entry that gains a product importer, or goes, leaves the list.
    expect([...NO_PRODUCT_IMPORTER_YET.keys()].filter((file) => !testOnly.includes(file))).toEqual(
      [],
    );
  });
});

const gitIn = (cwd: string, ...args: string[]): void => {
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args],
    { cwd, stdio: 'ignore' },
  );
};
describe('the docs history test in a clone and in a source export', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'git-history-'));
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('the docs history test passes in a clone and skips (not fails) in a source export', () => {
    const origin = join(scratch, 'origin');
    mkdirSync(origin);
    gitIn(origin, 'init', '-q');
    for (const n of [1, 2]) {
      writeFileSync(join(origin, 'file.txt'), `${n}\n`);
      gitIn(origin, 'add', 'file.txt');
      gitIn(origin, 'commit', '-q', '-m', `commit ${n}`);
    }
    gitIn(scratch, 'clone', '-q', `file://${origin}`, 'clone');
    gitIn(scratch, 'clone', '-q', '--depth', '1', `file://${origin}`, 'shallow');
    // A source export: files and no history, once on its own and once
    // unpacked inside another repository's work tree, whose history it
    // must not borrow.
    const bare = join(scratch, 'export');
    const nested = join(origin, 'export');
    for (const dir of [bare, nested]) {
      mkdirSync(dir);
      writeFileSync(join(dir, 'README.md'), 'an export\n');
    }

    expect(gitHistory(join(scratch, 'clone'))).toBe('full');
    expect(gitHistory(join(scratch, 'shallow'))).toBe('shallow');
    expect(gitHistory(bare)).toBe('none');
    expect(gitHistory(nested)).toBe('none');
  });

  it('reads history in the docs test only on a full clone', () => {
    const historyTest = readFileSync(
      join(root, 'tests/docs/authority-proofs-and-history-docs.test.ts'),
      'utf8',
    );
    expect(historyTest).toContain('resolve in the history of this head');
    expect(historyTest).toMatch(/describe\.skipIf\(gitHistory\(root\) !== 'full'\)/u);
  });
});

/** The cases a file declares: one per `it` or `test`, and one per row of a literal `.each`. */
function declaredCases(file: string, text: string): { title: string; cases: number }[] {
  const found: { title: string; cases: number }[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const n = node as Node;
    const called = n['type'] === 'CallExpression' ? chainRoot(n['callee']) : undefined;
    const title =
      called === 'it' || called === 'test'
        ? literalText((n['arguments'] as unknown[])[0])
        : undefined;
    if (title !== undefined) {
      const callee = n['callee'] as Node;
      const each =
        callee['type'] === 'CallExpression' &&
        ((callee['callee'] as Node)['property'] as Node | undefined)?.['name'] === 'each'
          ? ((callee['arguments'] as Node[])[0]?.['elements'] as unknown[] | undefined)
          : undefined;
      found.push({ title, cases: each === undefined ? 1 : each.length });
    }
    for (const value of Object.values(n)) visit(value);
  };
  visit(parseSync(file, text, { lang: 'ts' }).program);
  return found;
}

const sum = (files: Record<string, number>): number =>
  Object.values(files).reduce((a, b) => a + b, 0);

interface CaseLedger {
  readonly measured: string;
  readonly total: number;
  readonly before: {
    readonly head: string;
    readonly total: number;
    readonly files: Record<string, number>;
  };
  readonly after: { readonly total: number; readonly files: Record<string, number> };
  readonly added: {
    readonly total: number;
    readonly files: readonly {
      readonly file: string;
      readonly declared: readonly { readonly title: string; readonly cases: number }[];
      readonly names: readonly string[];
    }[];
  };
}

describe('the case count across the renames', () => {
  it('the pre-existing cases number the same before and after, and the cases this ticket adds are listed by name', () => {
    const ledger = JSON.parse(
      readFileSync(join(root, 'tests/docs/test-case-counts.json'), 'utf8'),
    ) as CaseLedger;
    // Pre-existing: every file, under its name at this head, before and after.
    expect(Object.keys(ledger.after.files).toSorted()).toEqual(
      Object.keys(ledger.before.files).toSorted(),
    );
    const moved = Object.keys(ledger.before.files).filter(
      (file) => ledger.before.files[file] !== ledger.after.files[file],
    );
    expect(moved).toEqual([]);
    expect(ledger.before.total).toBe(sum(ledger.before.files));
    expect(ledger.after.total).toBe(sum(ledger.after.files));
    expect(ledger.after.total).toBe(ledger.before.total);
    expect(Object.keys(ledger.after.files).filter((file) => !existsSync(join(root, file)))).toEqual(
      [],
    );
    // Added: the new cases, by name, as each file that adds them declares them.
    let added = 0;
    for (const { file, declared, names } of ledger.added.files) {
      expect(ledger.before.files[file]).toBeUndefined();
      expect(declared).toEqual(declaredCases(file, readFileSync(join(root, file), 'utf8')));
      const cases = declared.reduce((a, b) => a + b.cases, 0);
      expect(names).toHaveLength(cases);
      added += cases;
    }
    expect(ledger.added.total).toBe(added);
    expect(ledger.total).toBe(ledger.after.total + ledger.added.total);
  });
});

describe('test files for one task step, in one folder', () => {
  it('the test files for task pickup come back by name, from one folder', () => {
    const pickup = tracked('tests').filter((file) => /pickup/u.test(file.split('/').pop() ?? ''));
    expect(pickup.filter((file) => file.endsWith('.test.ts')).length).toBeGreaterThanOrEqual(6);
    expect(pickup.filter((file) => !file.startsWith('tests/pickup/'))).toEqual([]);
  });
});
