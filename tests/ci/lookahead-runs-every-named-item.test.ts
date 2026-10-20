// SPDX-License-Identifier: AGPL-3.0-only
//
// The nightly Postgres 18 look-ahead (lookahead.yml) runs the named suites
// through the same runner as the required database shards, but it has no
// isolation matrix beside it. The required shards leave the isolation suites
// to the `isolation tests` shards; the nightly run must still hold them, or
// the look-ahead stops covering the pooled-crossover and restricted-call
// suites on the next major. This runs each nightly shard's own command with
// `--list` and holds the shards together to the whole manifest, once each.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { censusOf } from '../../scripts/db-census.ts';
import { planItems, readPlan } from '../../scripts/db-shards.ts';
import { readNamedSuites } from '../../scripts/named-suites.ts';
import { ROOT } from './merge-group-repo.ts';

type Step = { run?: string };
type Job = { strategy?: { matrix?: { shard?: number[] } }; steps?: Step[] };

const nightly = parse(readFileSync(join(ROOT, '.github/workflows/lookahead.yml'), 'utf8')) as {
  jobs: Record<string, Job>;
};
const scripts = (
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

/** One nightly shard's run items, from the workflow's own command with `--list`. */
function listed(command: string, shard: string): string[] {
  // `pnpm run <name>` resolved to the package script, so only the runner prints.
  const script = command.replace(
    /^pnpm run ([\w:-]+)/u,
    (_, name: string) => scripts[name] ?? name,
  );
  const run = spawnSync('bash', ['--noprofile', '--norc', '-c', `${script} --list`], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, SHARD: shard, DATABASE_URL: 'postgres://unused@127.0.0.1:1/x' },
  });
  // --list runs nothing, so it never exits 0.
  expect(run.status, run.stderr).toBe(3);
  return run.stdout.split('\n').filter(Boolean);
}

it('the nightly Postgres 18 commands run every named item once, the isolation suites included', () => {
  const job = nightly.jobs['lookahead'];
  const count = job?.strategy?.matrix?.shard?.length ?? 0;
  const command = job?.steps?.find((step) => step.run?.includes('db:conformance'))?.run ?? '';
  expect(count).toBeGreaterThan(0);
  expect(command).toContain('db:conformance');
  const manifest = readNamedSuites(ROOT);
  const items = planItems(
    [...manifest.invariant, ...manifest.conformance],
    readPlan(join(ROOT, 'tests/db/shard-plan.json')).parts,
  );
  const shards = Array.from({ length: count }, (_, i) =>
    listed(command, `${String(i + 1)}/${String(count)}`),
  );
  expect(censusOf(items, shards, {})).toStrictEqual({
    items: items.length,
    placed: items.length,
    missing: [],
    twice: [],
    extra: [],
    tests: 0,
  });
}, 120_000);
