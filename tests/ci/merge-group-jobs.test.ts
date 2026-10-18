// SPDX-License-Identifier: AGPL-3.0-only
//
// CI-SPEED (ORCH78 LOOKAHEAD, YAMLPARSE): the job-level twin of merge-group-workflows.test.ts's
// step rule. A merge group runs every job, and no job waits on one that is skipped there or does
// not exist, directly or through another job: a job that did would be skipped on every group, and
// a skipped required check reads as passed. The Postgres 18 look-ahead, the one job that ran on
// pull requests alone, left ci.yml for a nightly workflow (CI-SPEED, NATHAN-CF-RECORD item 1), so
// no job here is excused any more. The workflows are read with a YAML parser, so a form a line
// pattern would misread (a block list, a folded value, an alias, a comment in column one) is read
// as GitHub reads it.

import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { read } from './merge-group-repo.ts';
import { OPEN_GUARD, unguarded } from './open-pull-request.ts';
import { FULL_GUARD, HEAVY } from './full-checks.ts';
import { scopeOf } from '../../scripts/full-run.ts';
import { SHARDS_RUN } from './precheck-batch.ts';

const CI = '.github/workflows/ci.yml';
const REVIEW = '.github/workflows/review-evidence.yml';
/** Not required, and nightly since CI-SPEED; it must not come back as a required check. */
const LOOKAHEAD = 'database look-ahead, Postgres 18 (not required)';
const ONLY_PULL_REQUESTS = "github.event_name == 'pull_request'";
// `!= 'pull_request' || (a batch)` never skips a group: the database conformance shards carry it
// (CI-SPEED, light pull requests; #1918, pre-check batches). A required job carrying it is
// refused by merge-group-workflows.test.ts.
const ALLOWED = new Set([undefined, 'always()', "github.event_name != 'push'", SHARDS_RUN]);
// Cut 6 (13 October 2026): a job no required check names, kept out of merge groups on purpose.
// It may skip a group with exactly this condition, and no job may wait on it. The zizmor workflow
// audit joined on 18 October 2026, report-only until the owner's ruleset step.
const NOT_IN_GROUPS = "github.event_name != 'merge_group'";
const OUT_OF_GROUPS = new Set(['visual-drift', 'zizmor']);
const required = (
  JSON.parse(read('.github/required-checks.json')) as {
    required_status_checks: { context: string }[];
  }
).required_status_checks;

/** A condition as GitHub evaluates it: `${{ x }}` and `x` are the same expression. */
const condition = (value: unknown) =>
  typeof value === 'string' ? value.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/u, '$1') : value;

/**
 * Every way a workflow lets a merge group skip a job: a condition that could skip a group, or a
 * wait on a job that has one or that is not there. Empty when the workflow is sound; anything
 * unreadable is a problem.
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
    // Two IDs that differ only in case would share one entry, and the second would hide the first.
    if (table.has(key.toLowerCase())) problems.push(`${path}: ${key}: job ID repeats without case`);
    table.set(key.toLowerCase(), {
      name: typeof job?.['name'] === 'string' ? job['name'] : key,
      // The exact guard against closed pull requests never skips a group (open-pull-request.ts).
      cond: unguarded(condition(job?.['if'])),
      needs: list.filter((n) => typeof n === 'string').map((n) => n.toLowerCase()),
    });
  }
  // `full checks` alone may carry its guard: the gate's scope is never light on a group.
  const runs = (key: string, cond: unknown) =>
    ALLOWED.has(cond as string) || (key === 'full' && cond === FULL_GUARD);
  const allowed = (key: string, cond: unknown) =>
    runs(key, cond) || (OUT_OF_GROUPS.has(key) && cond === NOT_IN_GROUPS);
  const skips = (key: string) => {
    const job = table.get(key);
    return job === undefined || !runs(key, job.cond);
  };
  for (const [key, { name, cond }] of table) {
    if (!allowed(key, cond)) problems.push(`${path}: ${name}: if: ${String(cond)}`);
    const seen = new Set<string>();
    const todo = [...(table.get(key)?.needs ?? [])];
    for (let n = todo.pop(); n !== undefined; n = todo.pop()) {
      if (seen.has(n)) continue;
      seen.add(n);
      todo.push(...(table.get(n)?.needs ?? []));
    }
    for (const n of seen) if (skips(n)) problems.push(`${path}: ${name}: waits on ${n}`);
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
const PARITY = '    name: command parity\n    needs: [gate, full]\n';

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
        '    name: isolation tests shard ${{ matrix.shard }}\n    needs: [gate, full]\n',
        '    name: isolation tests shard ${{ matrix.shard }}\n    needs: [gate, full, parity]\n',
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
  [
    'a required job kept out of merge groups',
    [licences(`    needs: [gate]\n    if: ${NOT_IN_GROUPS}\n`)],
  ],
  ['a wait on a job kept out of merge groups', [licences('    needs: [gate, visual-drift]\n')]],
  [
    'a job ID repeated without case',
    [
      [
        '  licences:\n',
        `  Sneaky:\n    name: sneaky\n    needs: [gate]\n    if: ${ONLY_PULL_REQUESTS}\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n  SNEAKY:\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n  licences:\n`,
      ],
    ],
  ],
];

describe('merge group: no job skips a group', () => {
  it('no job skips a group, waits on one that does, or waits on one that is not there', () => {
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
    // A planted condition is refused as that condition; any other plant as a wait on a job that is
    // not there (the look-ahead's old ID, which no longer names a job in ci.yml).
    const conditioned = swaps.some(([, to]) =>
      /if ?: github\.event_name == 'pull_request'/u.test(to),
    );
    const reason = _form.includes('repeated')
      ? 'job ID repeats without case'
      : conditioned
        ? `if: ${ONLY_PULL_REQUESTS}`
        : _form.includes('kept out')
          ? _form.includes('wait')
            ? 'waits on visual-drift'
            : `OSI licence allowlist: if: ${NOT_IN_GROUPS}`
          : 'waits on database-lookahead';
    expect(groupSkips(planted(...swaps), CI).join('\n')).toContain(reason);
  });

  it('refuses a guard against closed pull requests that is not the exact one', () => {
    const mangled = `always() && ${OPEN_GUARD}`;
    const text = planted(licences(`    needs: [gate]\n    if: ${mangled}\n`));
    expect(groupSkips(text, CI)).toContain(`${CI}: OSI licence allowlist: if: ${mangled}`);
  });

  it('refuses a duplicate key and a workflow it cannot parse', () => {
    expect(
      groupSkips(planted(licences('    needs: [gate]\n    needs: [gate]\n')), CI),
    ).not.toStrictEqual([]);
    expect(groupSkips('jobs: [', CI)).not.toStrictEqual([]);
  });
});

describe('merge group: the full checks job skips no group', () => {
  const ci = parseDocument(read(CI)).toJS() as {
    jobs: Record<
      string,
      {
        name?: string;
        if?: string;
        needs?: string[];
        outputs?: Record<string, string>;
        steps?: { id?: string; run?: string; if?: string }[];
      }
    >;
  };

  it('is full on every merge group, from a gate step that runs on every event', () => {
    for (const payload of [undefined, {}, { pull_request: { labels: [] } }])
      expect(scopeOf({ eventName: 'merge_group', payload, tested: true, queueBusy: true })).toBe(
        'full',
      );
    const gate = ci.jobs['gate'];
    expect(gate?.outputs).toStrictEqual({ scope: '${{ steps.scope.outputs.scope }}' });
    const steps = (gate?.steps ?? []).filter((step) => step.id === 'scope');
    expect(steps).toHaveLength(1);
    expect(steps[0]?.run).toBe('node scripts/full-run.ts');
    expect(steps[0]).not.toHaveProperty('if');
    expect(steps[0]).not.toHaveProperty('continue-on-error');
  });

  it('waits on the gate alone under its exact guard, and every heavy job waits on it', () => {
    expect(ci.jobs['full']?.name).toBe('full checks');
    expect(ci.jobs['full']?.needs).toStrictEqual(['gate']);
    expect(ci.jobs['full']?.if).toBe(FULL_GUARD);
    const waiting = Object.entries(ci.jobs)
      .filter(([, job]) => (job.needs ?? []).includes('full'))
      .map(([key]) => key)
      .toSorted();
    expect(waiting).toStrictEqual(
      [...HEAVY, 'database', 'isolation-tests', 'local-checks'].toSorted(),
    );
  });

  it('refuses the guard on any other job, or any other guard on it', () => {
    const elsewhere = planted(licences(`    needs: [gate]\n    if: ${FULL_GUARD}\n`));
    expect(groupSkips(elsewhere, CI)).toContain(`${CI}: OSI licence allowlist: if: ${FULL_GUARD}`);
    const other = "needs.gate.outputs.scope == 'full'";
    const swapped = planted([`    if: ${FULL_GUARD}\n`, `    if: ${other}\n`]);
    expect(groupSkips(swapped, CI)).toContain(`${CI}: full checks: if: ${other}`);
  });
});
