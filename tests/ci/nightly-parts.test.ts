// SPDX-License-Identifier: AGPL-3.0-only
// #2302: scripts/ops/nightly-parts.sh, the M5's nightly run of the suites
// tests/db/shard-plan.json splits into parts, the only place they now run.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../..');
const script = join(repo, 'scripts/ops/nightly-parts.sh');
const planParts = (root: string): string[] =>
  Object.keys(
    (
      JSON.parse(readFileSync(join(root, 'tests/db/shard-plan.json'), 'utf8')) as {
        parts: Record<string, number>;
      }
    ).parts,
  );
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

describe('the nightly parts list', () => {
  it("is the shard plan's parts, every one of them", () => {
    const done = run(['--list', repo]);
    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout.trim().split('\n')).toEqual(planParts(repo));
  });

  it('takes a part added to the plan with no edit to the runner', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'nightly-parts-plan-'));
    try {
      mkdirSync(join(scratch, 'tests/db'), { recursive: true });
      const plan = JSON.parse(readFileSync(join(repo, 'tests/db/shard-plan.json'), 'utf8')) as {
        parts: Record<string, number>;
      };
      plan.parts['tests/tenancy/a-new-long-suite.test.ts'] = 3;
      writeFileSync(join(scratch, 'tests/db/shard-plan.json'), JSON.stringify(plan));
      const done = run(['--list', scratch]);
      expect(done.status, done.stderr).toBe(0);
      expect(done.stdout.trim().split('\n')).toEqual(planParts(scratch));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('refuses a plan with no parts rather than running nothing green', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'nightly-parts-empty-'));
    try {
      mkdirSync(join(scratch, 'tests/db'), { recursive: true });
      writeFileSync(join(scratch, 'tests/db/shard-plan.json'), '{"parts":{}}');
      expect(run(['--list', scratch]).status).not.toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

const title = 'nightly parts: tests/tenancy/restricted-calls-prefixes.test.ts red on main';
const MARKER = 'planted-token-marker-2302';
const BOT: Record<string, string> = { NIGHTLY_GH_USER: 'nightly-bot' };
// A fake gh: records each call, answers `issue list` from OPEN_ISSUES.
const withGh = (
  openIssues: string,
  check: (calls: string, out: string, status: number | null) => void,
  env: Record<string, string> = BOT,
) => {
  const scratch = mkdtempSync(join(tmpdir(), 'nightly-parts-gh-'));
  try {
    const bin = join(scratch, 'bin');
    mkdirSync(bin);
    const calls = join(scratch, 'calls');
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/bash
{ printf 'CALL'; printf ' [%s]' "$@"; printf ' token=%s\\n' "\${GH_TOKEN:-}"; } >>"${calls}"
for a in "$@"; do [ -f "$a" ] && { echo BODY; cat "$a"; } >>"${calls}"; done
case "$1 $2" in
"auth token") printf '%s\\n' '${MARKER}' ;;
"issue list") printf '%s' "$OPEN_ISSUES" ;;
"issue create") echo https://github.com/LaunchAstro/ops-astro/issues/9001 ;;
esac
exit 0
`,
      { mode: 0o755 },
    );
    const log = join(scratch, 'suite.log');
    writeFileSync(log, 'FAIL tests/tenancy/restricted-calls-prefixes.test.ts > a case\n');
    const done = run(
      ['--file-issue', 'tests/tenancy/restricted-calls-prefixes.test.ts', log, 'abc1234'],
      { ...env, PATH: `${bin}:${process.env['PATH'] ?? ''}`, OPEN_ISSUES: openIssues },
    );
    check(
      existsSync(calls) ? readFileSync(calls, 'utf8') : '',
      done.stdout + done.stderr,
      done.status,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

describe('a red suite files one issue', () => {
  it('opens a labelled issue as the bot login when none is open for the suite', () => {
    const other = 'nightly parts: tests/acceptance/d06-agent.test.ts red on main';
    withGh(JSON.stringify([{ number: 5, title: other }]), (calls, out, status) => {
      expect(status, out).toBe(0);
      expect(calls).toContain('CALL [auth] [token] [-h] [github.com] [-u] [nightly-bot]');
      const create = calls.split('\n').find((line) => line.startsWith('CALL [issue] [create]'));
      expect(create).toContain(`[--title] [${title}]`);
      expect(create).toContain('[--label] [nightly-parts]');
      expect(create).toContain(`token=${MARKER}`);
      expect(calls).toContain('a case');
      expect(calls).not.toContain('CALL [issue] [comment]');
      expect(out).not.toContain(MARKER);
    });
  });

  it('comments on the open issue for the same suite instead of opening another', () => {
    const open = [
      { number: 5, title: 'nightly parts: tests/acceptance/d06-agent.test.ts red on main' },
      { number: 77, title },
    ];
    withGh(JSON.stringify(open), (calls, out, status) => {
      expect(status, out).toBe(0);
      expect(calls).toContain('[--label] [nightly-parts]');
      expect(calls).toContain('CALL [issue] [comment] [77]');
      expect(calls).not.toContain('CALL [issue] [create]');
      expect(out).not.toContain(MARKER);
    });
  });

  it('posts nothing, and fails, when no bot login is named', () => {
    withGh(
      '[]',
      (calls, out, status) => {
        expect(status).not.toBe(0);
        expect(calls).not.toContain('CALL');
        expect(out).toContain('NIGHTLY_GH_USER is unset');
      },
      {},
    );
  });
});

describe('the LaunchAgent template', () => {
  it('starts the runner at 02:00 on the M5 (Australia/Brisbane, AEST)', () => {
    const plist = readFileSync(join(repo, 'deploy/m5/ops-astro-nightly-parts.plist'), 'utf8');
    expect(plist).toMatch(
      /<key>StartCalendarInterval<\/key>\s*<dict>\s*<key>Hour<\/key>\s*<integer>2<\/integer>\s*<key>Minute<\/key>\s*<integer>0<\/integer>\s*<\/dict>/u,
    );
    expect(plist).toContain('nightly-parts.sh');
    expect(plist).not.toContain('<key>RunAtLoad</key>');
  });
});
