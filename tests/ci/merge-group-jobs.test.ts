// SPDX-License-Identifier: AGPL-3.0-only
//
// CI-SPEED (ORCH78 LOOKAHEAD, YAMLPARSE): the job-level twin of merge-group-workflows.test.ts's
// step rule. A merge group runs every job but the not-required Postgres 18 look-ahead, and no job
// waits on that one, directly or through another job: a job that did would be skipped on every
// group, and a skipped required check reads as passed. The workflows are read with a YAML parser,
// so a form a line pattern would misread (a block list, a folded value, an alias, a comment in
// column one) is read as GitHub reads it.

import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { read } from './merge-group-repo.ts';

const CI = '.github/workflows/ci.yml';
const REVIEW = '.github/workflows/review-evidence.yml';
const LOOKAHEAD = 'database look-ahead, Postgres 18 (not required)';
const ONLY_PULL_REQUESTS = "github.event_name == 'pull_request'";
const ALLOWED = new Set([undefined, 'always()', "github.event_name != 'push'"]);
const required = (
  JSON.parse(read('.github/required-checks.json')) as {
    required_status_checks: { context: string }[];
  }
).required_status_checks;

/** A condition as GitHub evaluates it: `${{ x }}` and `x` are the same expression. */
const condition = (value: unknown) =>
  typeof value === 'string' ? value.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/u, '$1') : value;

/**
 * Every way a workflow lets a merge group skip a job: a job other than the look-ahead with a
 * condition that could skip a group, a look-ahead that runs anywhere but pull requests, or a job
 * that waits on the look-ahead. Empty when the workflow is sound; anything unreadable is a problem.
 */
export function groupSkips(text: string, path: string): string[] {
  // Merge keys resolved and duplicate keys refused, so neither can hide a `needs` or an `if`.
  const doc = parseDocument(text, { merge: true, uniqueKeys: true });
  if (doc.errors.length > 0) return doc.errors.map((e) => `${path}: ${e.message}`);
  const jobs = (doc.toJS({ maxAliasCount: 100 }) as { jobs?: unknown }).jobs;
  if (typeof jobs !== 'object' || jobs === null) return [`${path}: no jobs map`];
  const problems: string[] = [];
  // Job IDs compared without case, as GitHub matches them.
  const table = new Map<string, { name: string; cond: unknown; needs: string[] }>();
  for (const [key, job] of Object.entries(jobs as Record<string, Record<string, unknown>>)) {
    const raw = job?.['needs'];
    const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    if (!list.every((n) => typeof n === 'string')) problems.push(`${path}: ${key}: needs unread`);
    table.set(key.toLowerCase(), {
      name: typeof job?.['name'] === 'string' ? job['name'] : key,
      cond: condition(job?.['if']),
      needs: list.filter((n) => typeof n === 'string').map((n) => n.toLowerCase()),
    });
  }
  const look = [...table].find(([, j]) => j.name === LOOKAHEAD)?.[0];
  for (const [key, { name, cond }] of table) {
    const ok = key === look ? cond === ONLY_PULL_REQUESTS : ALLOWED.has(cond as string);
    if (!ok) problems.push(`${path}: ${name}: if: ${String(cond)}`);
    const seen = new Set<string>();
    const todo = [...(table.get(key)?.needs ?? [])];
    for (let n = todo.pop(); n !== undefined; n = todo.pop()) {
      if (seen.has(n)) continue;
      seen.add(n);
      todo.push(...(table.get(n)?.needs ?? []));
    }
    if (look !== undefined && seen.has(look)) problems.push(`${path}: ${name}: waits on ${look}`);
  }
  return problems;
}

/** ci.yml with each `[from, to]` swap made once; a swap that does not match fails the case. */
function planted(...swaps: [string, string][]) {
  let text = read(CI);
  for (const [from, to] of swaps) {
    expect(text.split(from).length, from).toBe(2);
    text = text.replace(from, to);
  }
  return text;
}

const LICENCES = '    name: OSI licence allowlist\n    needs: [gate]\n';
const licences = (rest: string): [string, string] => [
  LICENCES,
  `    name: OSI licence allowlist\n${rest}`,
];
const PR_ONLY = `    needs: [gate]\n    if: ${ONLY_PULL_REQUESTS}\n`;
const PARITY = '    name: command parity\n    needs: [gate]\n';

// Every form rounds 2 to 4 of the security review planted, read through the parser.
const PLANTS: [string, [string, string][]][] = [
  ['a block-list wait', [licences('    needs:\n      - gate\n      - database-lookahead\n')]],
  ['an inline wait', [licences('    needs: [gate, database-lookahead]\n')]],
  ['a bare-name wait', [licences('    needs: database-lookahead\n')]],
  ['a flow list split across lines', [licences('    needs: [gate,\n      database-lookahead]\n')]],
  ['a folded value', [licences('    needs: >-\n      database-lookahead\n')]],
  ['an alias', [licences('    env:\n      X: &la database-lookahead\n    needs: *la\n')]],
  ['a space before the colon', [licences('    needs : [gate, database-lookahead]\n')]],
  ['a merge key', [licences('    <<: { needs: [database-lookahead] }\n')]],
  ['`if :` on a required job', [licences(`    needs: [gate]\n    if : ${ONLY_PULL_REQUESTS}\n`)]],
  ['a pull-request-only required job', [licences(PR_ONLY)]],
  ['a quoted job key', [['  licences:\n', '  "licences":\n'], licences(PR_ONLY)]],
  ['a job key with a comment', [['  licences:\n', '  licences: # x\n'], licences(PR_ONLY)]],
  [
    'a wait through another job',
    [[PARITY, '    name: command parity\n    needs: [database-lookahead]\n']],
  ],
  [
    'a column-one comment before a block-list wait',
    [
      ['  parity:\n', '# note\n  parity:\n'],
      [PARITY, '    name: command parity\n    needs:\n      - database-lookahead\n'],
      [
        '    name: isolation tests\n    needs: [gate]\n',
        '    name: isolation tests\n    needs: [gate, parity]\n',
      ],
    ],
  ],
  [
    'a column-one comment before an inline wait',
    [
      ['  parity:\n', '# note\n  parity:\n'],
      [PARITY, '    name: command parity\n    needs: [database-lookahead]\n'],
    ],
  ],
  ['a case variant of the job key', [licences('    needs: [gate, Database-Lookahead]\n')]],
];

describe('merge group: no job skips a group', () => {
  it('the look-ahead is not required, runs on pull requests alone, and nothing waits on it', () => {
    expect(required.map((c) => c.context)).not.toContain(LOOKAHEAD);
    expect(groupSkips(read(CI), CI)).toStrictEqual([]);
    expect(groupSkips(read(REVIEW), REVIEW)).toStrictEqual([]);
  });

  it('reads a condition written inside ${{ }} as the same condition', () => {
    const wrapped = planted(
      licences("    needs: [gate]\n    if: ${{ github.event_name != 'push' }}\n"),
    );
    expect(groupSkips(wrapped, CI)).toStrictEqual([]);
  });

  it.each(PLANTS)('refuses %s', (_form, swaps) => {
    // A planted condition is refused as that condition; any other plant as a wait on the look-ahead.
    const conditioned = swaps.some(([, to]) =>
      /if ?: github\.event_name == 'pull_request'/u.test(to),
    );
    const reason = conditioned ? `if: ${ONLY_PULL_REQUESTS}` : 'waits on database-lookahead';
    expect(groupSkips(planted(...swaps), CI).join('\n')).toContain(reason);
  });

  it('refuses a duplicate key and a workflow it cannot parse', () => {
    expect(
      groupSkips(planted(licences('    needs: [gate]\n    needs: [gate]\n')), CI),
    ).not.toStrictEqual([]);
    expect(groupSkips('jobs: [', CI)).not.toStrictEqual([]);
  });
});
