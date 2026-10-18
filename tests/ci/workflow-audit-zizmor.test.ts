// SPDX-License-Identifier: AGPL-3.0-only
//
// zizmor over .github/workflows (register 45 item b, 18 October 2026). Its first report-only run
// found two classes: checkouts that leave the job token in .git/config (#1840, artipacked) and
// matrix values expanded straight into `run:` shell text (#1841, template-injection). Every
// workflow is read here with a YAML parser and held to both rules, and ci.yml's `workflow audit`
// job runs zizmor itself on each pull request and push to main: offline, at a pinned version,
// through an action pinned by commit, after the contamination gate, outside the merge queue and
// not a required check until the owner's ruleset step.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { read, ROOT } from './merge-group-repo.ts';

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
type Job = {
  name?: string;
  needs?: unknown;
  if?: unknown;
  'runs-on'?: unknown;
  'timeout-minutes'?: unknown;
  'continue-on-error'?: unknown;
  permissions?: unknown;
  steps?: Step[];
};
type Workflow = { jobs: Record<string, Job> };

const WORKFLOWS = '.github/workflows';
const files = readdirSync(join(ROOT, WORKFLOWS)).filter((f) => /\.ya?ml$/u.test(f));
const load = (file: string): Workflow => {
  const doc = parseDocument(read(`${WORKFLOWS}/${file}`), { merge: true, uniqueKeys: true });
  expect(doc.errors, file).toStrictEqual([]);
  return doc.toJS({ maxAliasCount: 100 }) as Workflow;
};
const steps = (file: string): [string, Step][] =>
  Object.entries(load(file).jobs).flatMap(([key, job]) =>
    (job.steps ?? []).map((step, i): [string, Step] => [
      `${file} ${key} step ${String(i + 1)}`,
      step,
    ]),
  );

const required = (
  JSON.parse(read('.github/required-checks.json')) as {
    required_status_checks: { context: string }[];
  }
).required_status_checks.map((c) => c.context);

// zizmor-action v0.6.4 pulls the zizmor image by the digest it records for the version asked
// for, and refuses a version it has no digest for. Both releases are 39 days old on 18 October
// 2026, past renovate.json's seven-day minimum.
const ACTION = 'zizmorcore/zizmor-action@cc914d7f3750a2d13d75c7f184a1060aa0e9d482';
const VERSION = '1.30.1';

describe('the two classes zizmor found stay fixed in every workflow', () => {
  it('every checkout leaves no token in .git/config (#1840)', () => {
    const checkouts = files
      .flatMap(steps)
      .filter(([, step]) => step.uses?.startsWith('actions/checkout@') === true);
    expect(checkouts.length).toBeGreaterThan(20);
    const keeping = checkouts
      .filter(([, step]) => step.with?.['persist-credentials'] !== false)
      .map(([where]) => where);
    expect(keeping).toStrictEqual([]);
  });

  it('no run: script expands a ${{ }} expression; each value arrives through env: (#1841)', () => {
    const expanding = files
      .flatMap(steps)
      .filter(([, step]) => step.run?.includes('${{') === true)
      .map(([where]) => where);
    expect(expanding).toStrictEqual([]);
  });

  it('each shard step reads its shard from env:, as the expressions it replaced gave it', () => {
    const ci = load('ci.yml');
    const shardSteps = ['check', 'database-shard', 'isolation'].flatMap((key) =>
      (ci.jobs[key]?.steps ?? []).filter((step) => step.run?.includes('--shard') === true),
    );
    expect(shardSteps).toHaveLength(11);
    for (const step of shardSteps) {
      expect(step.run).toMatch(/--shard "\$SHARD"/u);
      expect(step.run).not.toMatch(/--shard (?!"\$SHARD")/u);
      expect((step as { env?: Record<string, string> }).env?.['SHARD']).toBe(
        '${{ matrix.shard }}/${{ strategy.job-total }}',
      );
    }
  });
});

describe('the workflow audit job', () => {
  const ci = load('ci.yml');
  const entry = Object.entries(ci.jobs).filter(([, job]) => /zizmor/u.test(job.name ?? ''));

  it('is one job, behind the contamination gate, hosted and outside the merge queue', () => {
    expect(entry).toHaveLength(1);
    const [key, job] = entry[0] ?? ['', {}];
    expect(key).toBe('zizmor');
    expect(job.name).toBe('workflow audit (zizmor, not required)');
    expect(job.needs).toStrictEqual(['gate']);
    expect(job.if).toBe("github.event_name != 'merge_group'");
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job['timeout-minutes']).toBe(10);
    expect(job['continue-on-error']).toBeUndefined();
    // Read-only: it inherits the workflow's `contents: read` and asks for nothing more.
    expect(job.permissions).toBeUndefined();
  });

  it('is not a required check: that waits for the owner’s ruleset step', () => {
    for (const [, job] of entry) expect(required).not.toContain(job.name);
  });

  it('runs zizmor offline, at a pinned version, through an action pinned by commit', () => {
    const job = entry[0]?.[1];
    const audit = (job?.steps ?? []).filter((step) => step.uses?.startsWith('zizmorcore/'));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.uses).toBe(ACTION);
    expect(audit[0]?.with).toStrictEqual({
      version: VERSION,
      inputs: '.github/workflows',
      'online-audits': false,
      'advanced-security': false,
      token: '',
    });
    expect(read(`${WORKFLOWS}/ci.yml`)).toContain(`${ACTION} # v0.6.4`);
    expect(read('docs/supply-chain-pins.md')).toMatch(
      /^\| `zizmorcore\/zizmor-action` +\| v0\.6\.4 +\| `cc914d7f3750a2d13d75c7f184a1060aa0e9d482` \|/mu,
    );
  });
});
