// SPDX-License-Identifier: AGPL-3.0-only
//
// CI-SPEED (ORCH78 LOOKAHEAD): the job-level twin of merge-group-workflows.test.ts's step rule.
// A merge group runs every job but the not-required Postgres 18 look-ahead, and no job waits on
// that one, so no required check is skipped on a group.

import { describe, expect, it } from 'vitest';
import { read } from './merge-group-repo.ts';
import { top } from './workflow-text.ts';

const CI = '.github/workflows/ci.yml';
const REVIEW = '.github/workflows/review-evidence.yml';
const required = (
  JSON.parse(read('.github/required-checks.json')) as {
    required_status_checks: { context: string }[];
  }
).required_status_checks;
const jobs = (text: string) =>
  top(text, 'jobs')
    .split(/^(?= {2}[\w-]+:$)/mu)
    .slice(1);

// CI-SPEED (ORCH78 LOOKAHEAD): one job may skip a group, the Postgres 18 look-ahead, which is
// not required and runs on pull requests alone. Every other job runs on a group, and no job
// waits on the look-ahead, directly or through another job: a job that did would be skipped on
// every group, and a skipped required check reads as passed.
const LOOKAHEAD = 'database look-ahead, Postgres 18 (not required)';
const ALLOWED = new Set([undefined, 'always()', "github.event_name != 'push'"]);

/** Each job of a workflow by its key: its name, its one condition and what it waits on. */
function jobTable(path: string) {
  const text = top(read(path), 'jobs');
  // The one form these cases read (review3 M7's rule, for jobs): a job key is a bare key alone on
  // its line, and every line at a job's own depth is a bare key with its value or a whole-line
  // comment, so no quoted key, no space before a colon, no merge key and no complex key. `needs`
  // is one inline list or one name on one line: no block list, no list split across lines, no
  // folded value, no anchor or alias. Any other form fails here rather than being misread.
  for (const line of text.split('\n').slice(1)) {
    if (/^ {2}[^\s#]/u.test(line)) expect(line, `${path}: job key`).toMatch(/^ {2}[\w-]+:$/u);
    if (/^ {4}\S/u.test(line))
      expect(line, `${path}: job-level key`).toMatch(/^ {4}(?:#.*|[a-z][\w-]*:(?: .*)?)$/u);
    if (/^ {4}needs:/u.test(line))
      expect(line, `${path}: needs`).toMatch(/^ {4}needs: (?:\[[\w-]+(?:, [\w-]+)*\]|[\w-]+)$/u);
  }
  return jobs(read(path)).map((block) => {
    const conds = [...block.matchAll(/^ {4}if: (.+)$/gmu)].map((m) => m[1]);
    expect(conds.length, `${path}: one condition at most`).toBeLessThan(2);
    const needs = /^ {4}needs: \[?([\w, -]+)\]?$/mu.exec(block)?.[1];
    return {
      key: /^ {2}([\w-]+):$/mu.exec(block)?.[1] ?? '',
      name: /^ {4}name: (.+)$/mu.exec(block)?.[1] ?? block.slice(0, 80),
      cond: conds[0],
      needs: needs ? needs.split(',').map((n) => n.trim()) : [],
    };
  });
}

describe('merge group: no job skips a group', () => {
  it('no job in either workflow skips a group, apart from the not-required look-ahead', () => {
    expect(required.map((c) => c.context)).not.toContain(LOOKAHEAD);
    for (const path of [CI, REVIEW])
      for (const { name, cond } of jobTable(path)) {
        const allowed =
          name === LOOKAHEAD ? cond === "github.event_name == 'pull_request'" : ALLOWED.has(cond);
        expect(allowed, `${path}: ${name}: if: ${cond}`).toBe(true);
      }
  });

  it('no job waits on the look-ahead, directly or through another job', () => {
    const table = jobTable(CI);
    const look = table.find((j) => j.name === LOOKAHEAD)?.key;
    expect(look).toBe('database-lookahead');
    const byKey = new Map(table.map((j) => [j.key, j]));
    const waitsOn = (key: string) => {
      const seen = new Set<string>();
      const todo = [...(byKey.get(key)?.needs ?? [])];
      for (let n = todo.pop(); n !== undefined; n = todo.pop()) {
        if (seen.has(n)) continue;
        seen.add(n);
        todo.push(...(byKey.get(n)?.needs ?? []));
      }
      return seen;
    };
    for (const { key, name } of table) expect(waitsOn(key).has(look ?? ''), name).toBe(false);
  });
});
