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

/** The lines a fake pnpm's log holds, one per call. */
const lines = (path: string | undefined): string[] =>
  readFileSync(path ?? '', 'utf8')
    .split('\n')
    .filter(Boolean);

/** What the fake pnpm's run of a step saw when the check left the bundle variable unset. */
const UNSET = '(unset)';

/**
 * How a check() run differs from the default: `scratch` runs it in an empty scratch directory
 * rather than the repository, so no real apps/web/dist is there to read; `stamp` is what the fake
 * build then writes to apps/web/dist/build.json under it; `inherited` is a CHECK_WEB_BUILD already
 * in the environment the check starts in.
 */
type CheckRun = { scratch?: boolean; stamp?: string; inherited?: string };

/**
 * scripts/check.mjs over a pnpm that records each call and passes, the calls it made, and, for
 * each call, the CHECK_WEB_BUILD it saw.
 */
function check(scopeName?: string, event?: string, eventFile = true, run: CheckRun = {}) {
  const dir = temp();
  const [log, seenLog, pnpm, payload] = ['pnpm.log', 'seen.log', 'pnpm.mjs', 'event.json'].map(
    (f) => join(dir, f),
  );
  writeFileSync(log ?? '', '');
  writeFileSync(seenLog ?? '', '');
  writeFileSync(
    pnpm ?? '',
    "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';\n" +
      "const call = process.argv.slice(2).join(' ');\n" +
      "appendFileSync(process.env.FAKE_PNPM_LOG, call + '\\n');\n" +
      `appendFileSync(process.env.FAKE_PNPM_SEEN, (process.env.CHECK_WEB_BUILD ?? '${UNSET}') + '\\n');\n` +
      "if (call === 'run build' && process.env.FAKE_PNPM_STAMP) {\n" +
      "  mkdirSync('apps/web/dist', { recursive: true });\n" +
      "  writeFileSync('apps/web/dist/build.json', JSON.stringify({ build: process.env.FAKE_PNPM_STAMP }));\n" +
      '}\n',
  );
  const pull = { number: 7, head: { sha: 'a'.repeat(40) }, base: { sha: BASE, ref: 'main' } };
  writeFileSync(payload ?? '', JSON.stringify({ pull_request: pull }));
  // A fake build writes its stamp under a scratch directory, never over the real bundle.
  if (run.stamp !== undefined && run.scratch !== true) throw new Error('a stamp needs scratch');
  const cwd = run.scratch === true ? temp() : ROOT;
  const out = spawnSync(process.execPath, [join(ROOT, 'scripts/check.mjs')], {
    cwd,
    env: withEvent({
      npm_execpath: pnpm,
      FAKE_PNPM_LOG: log,
      FAKE_PNPM_SEEN: seenLog,
      FAKE_PNPM_STAMP: run.stamp,
      CHECK_WEB_BUILD: run.inherited,
      CHECK_SCOPE: scopeName,
      GITHUB_EVENT_NAME: event,
      GITHUB_EVENT_PATH: eventFile ? payload : undefined,
    }),
    encoding: 'utf8',
  });
  return { ...out, ran: lines(log), seen: lines(seenLog) };
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

describe('pnpm check: the tests know which bundle this check just built', () => {
  const STAMP = 'c0ffee012345-dirty';
  const PLANTED = 'ba9876543210';

  it.each([
    ['a local run', undefined, undefined],
    ['a pull request', 'local checks', 'pull_request'],
  ])(
    '%s hands every step after the build the stamp it wrote, and no step before it one from outside',
    (_, scopeName, event) => {
      const run = check(scopeName, event, true, {
        scratch: true,
        stamp: STAMP,
        inherited: PLANTED,
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.seen).toHaveLength(run.ran.length);
      const build = run.ran.indexOf('run build');
      const tests = run.ran.findIndex((line) => line.startsWith('run test'));
      expect(build).toBeGreaterThan(0);
      expect(tests).toBeGreaterThan(build);
      expect(run.seen[tests]).toBe(STAMP);
      expect(run.seen.slice(0, build + 1)).toStrictEqual(
        run.ran.slice(0, build + 1).map(() => UNSET),
      );
      expect(run.seen.slice(build + 1)).toStrictEqual(run.ran.slice(build + 1).map(() => STAMP));
    },
    120_000,
  );

  it('a build that leaves no stamp names no build to any step, so a test reading the bundle builds it', () => {
    const run = check(undefined, undefined, true, { scratch: true, inherited: PLANTED });
    expect(run.status, run.stderr).toBe(0);
    expect(run.ran).toContain('run build');
    expect(run.seen).toStrictEqual(run.ran.map(() => UNSET));
  }, 120_000);
});
