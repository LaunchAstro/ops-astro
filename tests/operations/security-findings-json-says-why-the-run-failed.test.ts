// SPDX-License-Identifier: AGPL-3.0-only
//
// The security pass's saved findings.json is its machine-readable account of
// the run (`scripts/security/findings.mjs`). A missing report or a scan that
// was not signed in fails the run with no blocker or major found, so the file
// must say the run failed and why, beside the severity counts, as the table
// and the exit code do.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'sec-scan-json-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A ZAP report whose only alert is the 4xx rule, answered with `codes`. */
const answered = (codes: readonly string[]) => ({
  site: [
    {
      '@name': 'https://staging.example.test',
      alerts: [
        {
          pluginid: '100000',
          name: 'Client Error',
          riskcode: '0',
          instances: codes.map((evidence) => ({ uri: 'https://s.test/', evidence })),
        },
      ],
    },
  ],
});

/** Run the command into a fresh directory and read back its exit status and findings.json. */
function run(name: string, args: readonly string[]) {
  const out = join(dir, name);
  const ran = spawnSync(
    process.execPath,
    ['scripts/security/findings.mjs', ...args, '--out', out],
    { encoding: 'utf8' },
  );
  const saved = JSON.parse(readFileSync(join(out, 'findings.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  return { status: ran.status, saved };
}

it('findings.json records a missing report as a failed run, with the reason', () => {
  const { status, saved } = run('missing', ['--report', `baseline=${join(dir, 'absent.json')}`]);
  expect(status).toBe(1);
  expect(saved).toMatchObject({ fails: true, gate: { fails: false, blocker: 0, major: 0 } });
  expect(saved['problems']).toStrictEqual([expect.stringContaining('baseline report')]);
});

it('findings.json records a signed-out scan as a failed run, with the reason', () => {
  const planted = join(dir, 'signed-out.json');
  writeFileSync(planted, JSON.stringify(answered(['401', '401', '400'])));
  const { status, saved } = run('signed-out', ['--report', `api=${planted}`, '--signed-in', 'api']);
  expect(status).toBe(1);
  expect(saved).toMatchObject({ fails: true, gate: { fails: false, blocker: 0, major: 0 } });
  expect(saved['problems']).toStrictEqual([expect.stringContaining('was not signed in')]);
});

it('findings.json records a clean run as passing, with no problems', () => {
  const planted = join(dir, 'clean.json');
  writeFileSync(planted, JSON.stringify(answered(['400', '409'])));
  const { status, saved } = run('clean', ['--report', `api=${planted}`, '--signed-in', 'api']);
  expect(status).toBe(0);
  expect(saved).toMatchObject({ fails: false, problems: [], gate: { fails: false } });
});
