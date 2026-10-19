// SPDX-License-Identifier: AGPL-3.0-only
//
// The killed-drill cases (restore-drill-killed-parent.test.ts) pass under the
// run's temp guard: a drill killed mid-restore cannot remove its own working
// folder, so the case must. A Docker stand-in with the same stdin-close
// lifeline keeps real containers out of it, so only the folder is judged.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';

// Docker as the killed case sees it: the container is a file under the state
// folder, gone once its lifeline's pipe closes or it is removed.
const STAND_IN = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const a = process.argv.slice(2);
const state = process.env.DRILL_STAND_IN_STATE;
const file = n => path.join(state, n);
const remove = n => fs.rmSync(file(n), { force: true });
if (a[0] === 'run') {
  const name = a[a.indexOf('--name') + 1];
  fs.writeFileSync(file(name), '');
  console.log('invented-container-id');
} else if (a[0] === 'exec') {
  if (a.includes('sh')) {
    const name = a[a.indexOf('-i') + 1];
    process.stdin.resume();
    process.stdin.on('end', () => remove(name));
  } else if (a.join(' ').includes('show server_version_num')) console.log('170000');
} else if (a[0] === 'ps') {
  const filter = a[a.indexOf('--filter') + 1];
  const name = filter.slice('name=^/'.length, -1);
  if (fs.existsSync(file(name))) console.log(name);
} else if (a[0] === 'rm') remove(a.at(-1));
`;

/** The killed case, run as a run of its own with the stand-in first on PATH. */
const killedCase = (dir: string, state: string) =>
  new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        './node_modules/vitest/vitest.mjs',
        'run',
        'tests/ci/restore-drill-killed-parent.test.ts',
        '-t',
        'leaves no container when the drill is killed outright',
        '--maxWorkers=1',
      ],
      {
        env: { ...process.env, PATH: `${dir}:${process.env['PATH']}`, DRILL_STAND_IN_STATE: state },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });

it('a killed drill case leaves nothing in the temp folder for the temp guard to fail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drill-killed-harness-'));
  const state = join(dir, 'containers');
  mkdirSync(state);
  writeFileSync(join(dir, 'docker'), STAND_IN, { mode: 0o700 });
  try {
    const result = await killedCase(dir, state);
    expect(result.output).toMatch(/1 passed/u);
    expect(result.output).not.toContain('temp guard: this run left');
    expect(result.code, result.output).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
