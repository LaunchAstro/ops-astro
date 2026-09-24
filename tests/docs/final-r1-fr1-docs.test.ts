// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 1, lane FR1-DOCS: the doc statements the review found
// false at 6f13be8, held against the code they describe. Each case reads the
// code where it can, so a doc line that drifts from it again fails here.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

/** One `##` section of a markdown file, from its heading to the next one. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start < 0) throw new Error(`no section "${heading}"`);
  const next = text.indexOf('\n## ', start + heading.length + 4);
  return text.slice(start, next < 0 ? undefined : next);
}

/** Prose with its line breaks folded, so a phrase is found across a wrap. */
const folded = (text: string): string => text.replaceAll(/\s+/gu, ' ');

describe('AUTHORITY.md on task.comment (#21, #42, #61, #26)', () => {
  const authority = read('docs/local/AUTHORITY.md');

  it('says a trashed task is refused on both entries, and cites where', () => {
    expect(authority).not.toContain('Neither entry filters out a trashed task');
    const comments = folded(section(authority, 'Comments'));
    expect(comments).toMatch(/trashed task[^.]*NOT_FOUND/u);
    expect(comments).toContain('tests/acceptance/comment-rulings.test.ts');
    // The refusal the doc names is the one the handler makes.
    expect(read('packages/core-records/src/commands/tasks-comment.ts')).toContain(
      'if (on.target.deleted_at !== null) return refused(refuseNotFound());',
    );
  });

  it('records internal-only agent comments as the owner ruling, not a pending choice', () => {
    expect(folded(authority)).not.toContain('awaits root or owner confirmation');
    expect(folded(authority)).toMatch(/Internal-only is Nathan's ruling/u);
    expect(read('packages/core-records/src/commands/agent-operations.ts')).toContain(
      "const AGENT_AUDIENCES: ReadonlySet<string> = new Set(['internal']);",
    );
  });
});

describe('PROOFS.md "Open for the owner" (#28, #65)', () => {
  const open = section(read('docs/local/PROOFS.md'), 'Open for the owner');

  it('no longer asks for migrations that are written and approved', () => {
    expect(open).not.toContain('Neither is written');
    expect(open).not.toContain('Two protected storage migrations');
    expect(read('migrations/0024_cap_envelope_currency_binding.sql')).toContain('Nathan approved');
  });

  it('counts the items it lists', () => {
    const words = ['zero', 'one', 'two', 'three', 'four', 'five'];
    const bullets = open.split('\n').filter((line) => line.startsWith('- **')).length;
    expect(open).toContain(`These ${words[bullets] ?? '?'} are open for Nathan.`);
  });
});

describe('API.md task.pickup row (#29)', () => {
  const row = read('docs/local/API.md')
    .split('\n')
    .find((line) => line.startsWith('| `task.pickup`'));

  it('names every code pickup and its handler refuse with directly', () => {
    const sources = [
      read('packages/core-runtime/src/pickup.ts'),
      read('packages/core-records/src/commands/tasks-pickup.ts'),
    ].join('\n');
    const codes = new Set(
      [...sources.matchAll(/refuse(?:Command)?\(\s*'([A-Z_]+)'/gu)].map((match) => match[1]),
    );
    expect([...codes]).toEqual(expect.arrayContaining(['LEASE_HELD', 'SCOPE_NOT_GRANTED']));
    for (const code of codes) expect(row, code).toContain(`\`${code}\``);
  });
});

describe('the task.propose comment (#30, #66)', () => {
  it('states the seven-day maximum rather than no bound', () => {
    // Comment text with its ` * ` line starts folded away.
    const source = read('packages/core-records/src/commands/tasks-propose.ts').replaceAll(
      /\s*\n\s*\*\s?/gu,
      ' ',
    );
    expect(source).not.toMatch(/no\s+upper\s+bound/u);
    const before = source.slice(0, source.indexOf('export async function proposeOnTask'));
    expect(before.slice(before.lastIndexOf('/**'))).toContain('MAXIMUM_EXPIRY_SECONDS');
  });
});

describe('API.md on createApi (#31)', () => {
  it('calls executeRead required, as app.ts declares it', () => {
    const api = folded(read('docs/local/API.md'));
    expect(api).not.toMatch(/`executeRead` and `executeAgentCommand` are optional/u);
    expect(api).toContain('`executeCommand` and `executeRead` are required');
    expect(read('apps/api/app.ts')).toContain('readonly executeRead: ReadExecutor;');
  });
});

describe('CLI.md before a pickup (#37)', () => {
  it('names the decision refusal beside the operation one', () => {
    const cli = folded(read('docs/local/CLI.md'));
    expect(cli).toMatch(/`task\.decide` with `DELEGATION_EXCLUDES_DECISION`/u);
    expect(read('packages/core-records/src/commands/agent-authority.ts')).toContain(
      "'DELEGATION_EXCLUDES_DECISION'",
    );
  });
});

describe('RUNTIME.md "Why the money is two columns" (#63)', () => {
  it('does not claim storage refuses a zero actual, and names the barrier that does', () => {
    const money = folded(section(read('docs/local/RUNTIME.md'), 'Why the money is two columns'));
    expect(money).not.toContain('the schema refuses it');
    expect(money).toContain('ACTUAL_EXPENDITURE_UNSUPPORTED');
    expect(read('packages/core-runtime/src/handback.ts')).toContain(
      "'ACTUAL_EXPENDITURE_UNSUPPORTED'",
    );
  });
});

const git = (args: readonly string[], input?: string): string =>
  execFileSync('git', args, {
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();

const shallow = (() => {
  try {
    return git(['rev-parse', '--is-shallow-repository']) !== 'false';
  } catch {
    return true;
  }
})();

/** Every hash-shaped token in `text`, except one inside a path or file name. */
const hashTokens = (text: string): string[] =>
  [...text.matchAll(/(?<![\w/.-])[0-9a-f]{7,40}(?![\w/-])/gu)].map((match) => match[0]);

/** A whole comment line in a script or test: `//`, `/*` or a block's ` * `. */
const isCommentLine = (line: string): boolean => /^\s*(?:\/\/|\/\*|\*)/u.test(line);

describe.skipIf(shallow)('commit hashes cited in docs and code comments (#41)', () => {
  it('resolve in the history of this head', () => {
    const cited: { readonly file: string; readonly hash: string }[] = [];
    // A hash inside a path names an evidence directory outside the
    // repository, filed under the head's name when it was recorded.
    for (const file of git(['ls-files', 'docs/*.md']).split('\n').filter(Boolean)) {
      for (const hash of hashTokens(read(file))) cited.push({ file, hash });
    }
    // Comments in code and tests. Migrations are protected and keep the
    // hashes they were written with.
    const scripts = git(['ls-files', '*.ts', '*.tsx', '*.mjs', '*.js'])
      .split('\n')
      .filter((file) => file !== '' && !file.startsWith('migrations/'));
    for (const file of scripts) {
      for (const line of read(file)
        .split('\n')
        .filter((text) => isCommentLine(text))) {
        for (const hash of hashTokens(line)) cited.push({ file, hash });
      }
    }
    const hashes = [...new Set(cited.map((entry) => entry.hash))];
    // One line per hash: the full name and type, or "missing" for plain hex.
    const objects = git(['cat-file', '--batch-check'], `${hashes.join('\n')}\n`).split('\n');
    const commits = new Map<string, string>();
    for (const [index, line] of objects.entries()) {
      const [name, type] = line.split(' ');
      const hash = hashes[index];
      if (type === 'commit' && name !== undefined && hash !== undefined) commits.set(hash, name);
    }
    const history = new Set(git(['rev-list', 'HEAD']).split('\n'));
    const unreachable = cited
      .filter(({ hash }) => commits.has(hash) && !history.has(commits.get(hash) ?? ''))
      .map(({ file, hash }) => `${file}: ${hash}`);
    expect(commits.size).toBeGreaterThan(0);
    expect(cited.some(({ file }) => !file.startsWith('docs/'))).toBe(true);
    expect(unreachable).toEqual([]);
  });
});
