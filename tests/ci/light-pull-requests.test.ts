// SPDX-License-Identifier: AGPL-3.0-only
//
// CI-SPEED, light pull requests: a pull request's checks are the light set and flag issues; the
// full set runs in the merge queue, which is the only way into main, and a group or a push to main
// runs everything it ran before. This proves, by running the real scripts: scripts/ci-scope.ts
// defers a queue-only check on a pull request alone, running it on a group, a push and any other
// or empty event; `pnpm check` swaps only the full test run on a pull request for the tests the
// change reaches. The build runs everywhere and before the tests, because tests copy the bundle
// it writes to apps/web/dist. The workflow's side is light-pull-requests-workflow.test.ts.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readScopeMap } from '../../scripts/ci-scope.ts';
import { read, ROOT } from './merge-group-repo.ts';

/** The checks whose heavy part a pull request defers to the merge queue. */
const DEFERRED = ['local checks', 'isolation tests'];
const BASE = 'b'.repeat(40);

const scratch: string[] = [];
afterAll(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'light-pr-'));
  scratch.push(dir);
  return dir;
};

/** The environment with the event set as given; a name left out is unset. */
function withEvent(vars: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** scripts/ci-scope.ts for `check`, deciding, or wrapping `command`. No event file is given. */
function scope(name: string, event: string | undefined, ...command: string[]) {
  const args = command.length === 0 ? ['--decide'] : ['--', ...command];
  return spawnSync(process.execPath, ['scripts/ci-scope.ts', name, ...args], {
    cwd: ROOT,
    env: withEvent({ GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: '' }),
    encoding: 'utf8',
  });
}

/** scripts/check.mjs over a pnpm that records each call and passes, and the calls it made. */
function check(scopeName?: string, event?: string, eventFile = true) {
  const dir = temp();
  const [log, pnpm, payload] = ['pnpm.log', 'pnpm.mjs', 'event.json'].map((f) => join(dir, f));
  writeFileSync(log ?? '', '');
  writeFileSync(
    pnpm ?? '',
    "import { appendFileSync } from 'node:fs';\n" +
      "appendFileSync(process.env.FAKE_PNPM_LOG, process.argv.slice(2).join(' ') + '\\n');\n",
  );
  const pull = { number: 7, head: { sha: 'a'.repeat(40) }, base: { sha: BASE, ref: 'main' } };
  writeFileSync(payload ?? '', JSON.stringify({ pull_request: pull }));
  const out = spawnSync(process.execPath, ['scripts/check.mjs'], {
    cwd: ROOT,
    env: withEvent({
      npm_execpath: pnpm,
      FAKE_PNPM_LOG: log,
      CHECK_SCOPE: scopeName,
      GITHUB_EVENT_NAME: event,
      GITHUB_EVENT_PATH: eventFile ? payload : undefined,
    }),
    encoding: 'utf8',
  });
  return {
    ...out,
    ran: readFileSync(log ?? '', 'utf8')
      .split('\n')
      .filter(Boolean),
  };
}

describe('scripts/ci-scope.ts: a queue-only check', () => {
  it('the kept map defers exactly the two heavy checks, and refuses a malformed list', () => {
    const map = JSON.parse(read('scripts/ci-scope.json')) as Record<string, unknown>;
    expect(map['queueOnly']).toStrictEqual(DEFERRED);
    const bad = join(temp(), 'map.json');
    writeFileSync(bad, JSON.stringify({ ...map, queueOnly: 'local checks' }));
    expect(() => readScopeMap(bad)).toThrow(/queueOnly/u);
  });

  it.each(DEFERRED)('%s skips on a pull request, saying it runs in the merge queue', (name) => {
    // No event file: a deferred check reads no change, so nothing it could misread decides.
    const decided = scope(name, 'pull_request');
    expect(`${decided.status} ${decided.stdout}`, decided.stderr).toBe('0 skip\n');
    const run = scope(name, 'pull_request', 'sh', '-c', 'exit 7');
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toMatch(/merge queue/u);
  });

  it.each(DEFERRED)(
    '%s runs on a group, a push, and any other or empty event',
    (name) => {
      for (const event of [
        'merge_group',
        'push',
        'workflow_dispatch',
        'Pull_Request',
        '',
        undefined,
      ]) {
        const decided = scope(name, event);
        const label = `${String(event)}: ${decided.stderr}`;
        expect(`${decided.status} ${decided.stdout}`, label).toBe('0 run\n');
        expect(scope(name, event, 'sh', '-c', 'exit 7').status, String(event)).toBe(7);
      }
    },
    120_000,
  );

  it('a check that runs in full is refused, not deferred', () => {
    expect(scope('contamination gate', 'pull_request', 'true').status).toBe(2);
  });
});

describe('pnpm check: the light set on a pull request', () => {
  it('a group, a push, any other event and a local run run every step, the build before the tests', () => {
    const local = check();
    expect(local.status, local.stderr).toBe(0);
    expect(local.ran).toEqual(expect.arrayContaining(['run test', 'run build', 'run gate']));
    expect(local.ran.indexOf('run build')).toBeLessThan(local.ran.indexOf('run test'));
    expect(local.ran.length).toBeGreaterThan(30);
    for (const event of ['merge_group', 'push', 'workflow_dispatch', '']) {
      const run = check('local checks', event);
      expect(run.status, `${event}: ${run.stderr}`).toBe(0);
      expect(run.ran, event).toStrictEqual(local.ran);
    }
  }, 120_000);

  it('a pull request runs the build, then the tests the change reaches in place of the full tests, and every other step', () => {
    const full = check().ran;
    const light = check('local checks', 'pull_request');
    expect(light.status, light.stderr).toBe(0);
    const changed = `run test --changed ${BASE} --passWithNoTests`;
    expect(light.ran).toStrictEqual(full.map((line) => (line === 'run test' ? changed : line)));
    expect(light.ran.indexOf('run build')).toBeGreaterThanOrEqual(0);
    expect(light.ran.indexOf('run build')).toBeLessThan(light.ran.indexOf(changed));
    expect(light.stdout).toMatch(/tests \(pnpm run test\): the full run is in the merge queue/u);
  }, 120_000);

  it('a pull request whose base cannot be read fails before any step runs', () => {
    const run = check('local checks', 'pull_request', false);
    expect(run.status).not.toBe(0);
    expect(run.ran).toStrictEqual([]);
  });
});
