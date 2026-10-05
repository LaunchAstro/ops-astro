// SPDX-License-Identifier: AGPL-3.0-only
//
// A suite that starts containers adds a network interface on the runner, and
// Chromium aborts a page load in flight with net::ERR_NETWORK_CHANGED when one
// appears (MP-1-4's capture drew nothing in 3 loads on runs 36793828887 and
// 36796131629). So `local checks` runs `pnpm check` with those suites left out
// and runs them in a step of their own after it, never beside the captures.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
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

/** A relative module a file imports, statically or dynamically, or re-exports. */
const IMPORTS = /\b(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/gu;

/**
 * Whether a file, or a module it reaches through its relative imports, makes a
 * docker call that starts something. A suite that starts its container through
 * a helper module starts one all the same (CI-SPEED: the list used to read only
 * the test file's own text).
 */
const modules = new Map<string, { starts: boolean; imports: string[] }>();
function moduleAt(file: string): { starts: boolean; imports: string[] } {
  let read = modules.get(file);
  if (read === undefined) {
    const text = readFileSync(file, 'utf8');
    read = {
      starts: STARTS.test(text),
      imports: [...text.matchAll(IMPORTS)]
        .map(([, spec = '']) => relative('.', resolve(dirname(file), spec)))
        .filter((path) => existsSync(path)),
    };
    modules.set(file, read);
  }
  return read;
}

function startsContainer(file: string): boolean {
  const seen = new Set<string>();
  const todo = [file];
  for (let next = todo.pop(); next !== undefined; next = todo.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    const { starts, imports } = moduleAt(next);
    if (starts) return true;
    todo.push(...imports);
  }
  return false;
}

/** The `local checks` job's steps, as the workflow writes them. */
function localCheckSteps(): string[] {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const job = ci.slice(ci.indexOf('\n  check:\n'), ci.indexOf('\n  database-gate:\n'));
  return job.split(/\n {6}- /u).slice(1);
}

describe('suites that start containers run apart from the browser captures', () => {
  it('lists every suite that starts a container, and only files that exist', () => {
    const starting = testFiles().filter((file) => startsContainer(file));
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
