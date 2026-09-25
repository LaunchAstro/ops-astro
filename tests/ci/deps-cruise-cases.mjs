// SPDX-License-Identifier: AGPL-3.0-only
// Item 9: dependency-cruiser as a check, and the reason it is wrapped.
//
// Every fixture here is synthetic and disposable, built the way
// public-history-cases.mjs builds throwaway repositories: a temporary
// directory, its own .dependency-cruiser.cjs, and nothing taken from any real
// tree.
//
// Two cases carry the weight. `TypeScript is readable here because @swc/core
// is pinned` records why this tree can be cruised at all, measured against
// 18.4.0 rather than assumed fixed from the 18.3.0 the ticket named. And `a
// syntactically invalid tests/placeholder.test.ts fails and claims no read`
// is the coordinator's probe of 23 September, which walked straight through
// an exemption list an earlier revision of the runner carried.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repoRoot = resolve(import.meta.dirname, '../..');
const runner = join(repoRoot, 'scripts/deps-cruise.mjs');

const CONFIG = `module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: { parser: 'swc', doNotFollow: { path: 'node_modules' } },
};
`;

/** A disposable tree: { file: contents }, keyed by path relative to its root. */
function fixture(files, run, config = CONFIG) {
  const root = mkdtempSync(join(tmpdir(), 'hub-deps-cruise-'));
  try {
    writeFileSync(join(root, '.dependency-cruiser.cjs'), config);
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, path);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, contents);
    }
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const cruise = (root, ...targets) =>
  spawnSync(process.execPath, [runner, ...targets], {
    encoding: 'utf8',
    env: { ...process.env, DEPS_CRUISE_ROOT: root },
  });

// A cycle: src/a imports src/b, and src/b imports src/a back.
const CYCLE = {
  'src/a.mjs': "import { b } from './b.mjs';\nexport const a = b;\n",
  'src/b.mjs': "import { a } from './a.mjs';\nexport const b = a;\n",
};

const CLEAN = {
  'src/a.mjs': "import { b } from './b.mjs';\nexport const a = b;\n",
  'src/b.mjs': 'export const b = 1;\n',
};

test('a supported tree is read and a real dependency violation fails', () => {
  fixture(CYCLE, (root) => {
    const run = cruise(root, 'src');
    assert.equal(run.status, 1, `expected exit 1, got ${String(run.status)}: ${run.stderr}`);
    assert.match(run.stderr, /no-circular/u);
    assert.match(run.stdout, /2 module\(s\) cruised/u);
  });
});

test('a supported tree with no violation passes, and says what it read', () => {
  fixture(CLEAN, (root) => {
    const run = cruise(root, 'src');
    assert.equal(run.status, 0, `expected exit 0, got ${String(run.status)}: ${run.stderr}`);
    assert.match(run.stdout, /2 module\(s\) cruised/u);
    assert.match(run.stdout, /the tree was actually read/u);
  });
});

test('an import that does not resolve fails', () => {
  fixture(
    { 'src/a.mjs': "import { gone } from './nowhere.mjs';\nexport const a = gone;\n" },
    (root) => {
      const run = cruise(root, 'src');
      assert.equal(run.status, 1, `expected exit 1, got ${String(run.status)}`);
      assert.match(run.stderr, /no-unresolvable/u);
    },
  );
});

// TypeScript, read for real. .dependency-cruiser.cjs sets `parser: 'swc'`
// because 18.4.0's own TypeScript path supports typescript >=2.0.0 <7.0.0 and
// this tree pins 7.0.2. These cases hold both halves of that: the tree is
// read now, and it is not read without swc.
const TYPESCRIPT_CYCLE = {
  'src/a.ts': "import { b } from './b.ts';\nexport const a: number = b;\n",
  'src/b.ts': "import { a } from './a.ts';\nexport const b: number = a;\n",
};

test('a TypeScript tree is read and a real dependency violation fails', () => {
  fixture(TYPESCRIPT_CYCLE, (root) => {
    const run = cruise(root, 'src');
    assert.equal(run.status, 1, `expected exit 1, got ${String(run.status)}: ${run.stderr}`);
    assert.match(run.stderr, /no-circular/u);
    assert.match(run.stdout, /2 module\(s\) cruised/u);
  });
});

test('TypeScript is readable here because @swc/core is pinned, and that is load bearing', () => {
  // Measured on 23 September, before @swc/core was added: with typescript
  // 7.0.2 and no alternative parser, dependency-cruiser 18.4.0 read a
  // three-module TypeScript tree as `0 modules, 0 dependencies cruised`,
  // reported no violations, printed nothing on stderr and exited 0. That is
  // the silent skip the ticket named in 18.3.0, still present in 18.4.0.
  //
  // @swc/core is what closes it: given a parser it can use, dependency-cruiser
  // reads the tree whatever `options.parser` says, because it resolves to a
  // parser that is actually available. So the pin is the fix, and this case
  // fails if it is dropped.
  assert.doesNotThrow(
    () => createRequire(join(repoRoot, 'package.json')).resolve('@swc/core'),
    '@swc/core is gone, so TypeScript sources stop being read and start being skipped',
  );
  const pinned = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.match(
    String(pinned.devDependencies?.['@swc/core'] ?? ''),
    /^\d+\.\d+\.\d+$/u,
    '@swc/core must be pinned exactly, like every other dependency this tree relies on',
  );

  // And the guard that makes the loss loud rather than silent: a source in
  // scope that was not cruised is a failure, with no exemption available.
  fixture(TYPESCRIPT_CYCLE, (root) => {
    const run = cruise(root, 'src');
    assert.equal(run.status, 1, `expected exit 1, got ${String(run.status)}: ${run.stderr}`);
    assert.match(run.stdout, /2 module\(s\) cruised/u);
  });
});

// The coordinator's probe of 23 September, kept verbatim as a case. An earlier
// revision of the runner carried a list of paths declared unreadable, and
// `tests/placeholder.test.ts` was on it, so a syntactically invalid file at
// that exact path was skipped and the runner printed that the tree was read.
// There is no exemption list now. This case is what stops one coming back.
test('a syntactically invalid tests/placeholder.test.ts fails and claims no read', () => {
  fixture(
    {
      'scripts/visible.mjs': 'export const visible = 1;\n',
      'tests/placeholder.test.ts': 'this is ( not ] valid typescript {{{\nexport const broken =\n',
    },
    (root) => {
      const run = cruise(root, 'scripts', 'tests');
      assert.notEqual(run.status, 0, 'the invalid source escaped the gate again');
      assert.doesNotMatch(run.stdout, /actually read/u);
      assert.doesNotMatch(run.stderr, /actually read/u);
      assert.match(run.stderr, /could not be parsed/u);
    },
  );
});

test('a parse failure anywhere else in the tree fails too', () => {
  fixture(
    {
      'src/fine.mjs': 'export const fine = 1;\n',
      'src/nested/broken.ts': 'export const x: = ;;; }{\n',
    },
    (root) => {
      const run = cruise(root, 'src');
      assert.notEqual(run.status, 0, `expected non-zero, got ${String(run.status)}`);
      assert.doesNotMatch(run.stdout, /actually read/u);
      assert.match(run.stderr, /could not be parsed/u);
    },
  );
});

test('a target holding nothing cruisable fails rather than passing empty', () => {
  fixture({ 'src/notes.md': 'Not a module.\n' }, (root) => {
    const run = cruise(root, 'src');
    assert.equal(run.status, 1, `expected exit 1, got ${String(run.status)}`);
    assert.match(run.stderr, /read zero modules/u);
  });
});

test('a target that does not exist is a configuration error, not a pass', () => {
  fixture(CLEAN, (root) => {
    const run = cruise(root, 'no-such-directory');
    assert.equal(run.status, 2, `expected exit 2, got ${String(run.status)}`);
    assert.match(run.stderr, /none of the configured targets exist/u);
  });
});

// Copilot on PR A (C3): filtering the targets before checking them dropped a
// missing one whenever another existed, so `src typo` passed having cruised
// only `src`. A missing target is refused even when others exist.
test('one missing target among existing ones is a configuration error, not a pass', () => {
  fixture(CLEAN, (root) => {
    const run = cruise(root, 'src', 'typo');
    assert.equal(run.status, 2, `expected exit 2, got ${String(run.status)}: ${run.stdout}`);
    assert.match(run.stderr, /typo/u);
    assert.doesNotMatch(run.stdout, /actually read/u);
  });
});
