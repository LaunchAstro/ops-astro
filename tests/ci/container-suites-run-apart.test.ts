// SPDX-License-Identifier: AGPL-3.0-only
//
// A suite that starts containers adds a network interface on the runner, and
// Chromium aborts a page load in flight with net::ERR_NETWORK_CHANGED when one
// appears (MP-1-4's capture drew nothing in 3 loads on runs 36793828887 and
// 36796131629). So `local checks` runs `pnpm check` with those suites left out
// and runs them in a step of their own after it, never beside the captures.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const LIST = 'tests/ci/container-suites.json';
const listed: readonly string[] = (JSON.parse(readFileSync(LIST, 'utf8')) as { suites: string[] })
  .suites;

// A docker call that does more than ask `docker info` starts something.
const STARTS = /(?:spawn|spawnSync|execFile|execFileSync)\(\s*'docker',\s*(?!\['info'\])/u;

const testFiles = (): string[] =>
  readdirSync('tests', { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.test\.tsx?$/u.test(file))
    .map((file) => join('tests', file));

/** The `local checks` job's steps, as the workflow writes them. */
function localCheckSteps(): string[] {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const job = ci.slice(ci.indexOf('\n  check:\n'), ci.indexOf('\n  database-gate:\n'));
  return job.split(/\n {6}- /u).slice(1);
}

describe('suites that start containers run apart from the browser captures', () => {
  it('lists every suite that starts a container, and only files that exist', () => {
    const starting = testFiles().filter((file) => STARTS.test(readFileSync(file, 'utf8')));
    expect(starting.length).toBeGreaterThan(0);
    expect(listed.toSorted()).toStrictEqual(starting.toSorted());
  });

  it('leaves them out of `pnpm check` in local checks and runs them in a later step', () => {
    const steps = localCheckSteps();
    const check = steps.findIndex((step) => /^run: pnpm check\b/mu.test(step));
    expect(check).toBeGreaterThan(-1);
    expect(steps[check]).toMatch(/CONTAINER_SUITES: apart/u);
    const apart = steps.findIndex((step) => step.includes(LIST) && /vitest run/u.test(step));
    expect(apart).toBeGreaterThan(check);
    expect(steps[apart]).not.toMatch(/CONTAINER_SUITES/u);
  });

  it('is the list vitest leaves out when asked', () => {
    const config = readFileSync('vitest.config.ts', 'utf8');
    expect(config).toContain(LIST);
    expect(config).toMatch(/process\.env\['CONTAINER_SUITES'\] === 'apart'/u);
  });
});
