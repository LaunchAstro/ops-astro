// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isMap, isSeq, parseDocument } from 'yaml';

const NAME = 'Use the official HTTPS Ubuntu archive for browser dependencies';
const MIRRORS = '/etc/apt/apt-mirrors.txt';
const REPLACEMENT =
  's|http://azure\\.archive\\.ubuntu\\.com/ubuntu/|https://archive.ubuntu.com/ubuntu/|';
const ORIGINAL =
  'http://azure.archive.ubuntu.com/ubuntu/\n' +
  'http://archive.ubuntu.com/ubuntu/\n' +
  'https://azure.archive.ubuntu.com/ubuntu/\n' +
  'http://other.example/ubuntu/\n';

function bootstrapRun(job: string): string {
  const doc = parseDocument(readFileSync('.github/workflows/ci.yml', 'utf8'), {
    merge: true,
    uniqueKeys: true,
  });
  expect(doc.errors).toStrictEqual([]);
  const steps = doc.getIn(['jobs', job, 'steps'], true);
  if (!isSeq(steps)) throw new Error(`${job}: no steps`);
  const matches = steps.items.filter(isMap).filter((entry) => entry.get('name') === NAME);
  expect(matches).toHaveLength(1);
  const entry = matches[0];
  if (entry === undefined) throw new Error(`${job}: no bootstrap`);
  const run = entry.get('run');
  if (typeof run !== 'string') throw new Error(`${job}: no bootstrap command`);
  expect(entry.toJSON()).toStrictEqual({
    name: NAME,
    env: { RUNNER_ENVIRONMENT: '${{ runner.environment }}' },
    run,
  });
  return run;
}

// Record the real sudo arguments, then run the real sed expression on a temporary file.
// Omitting sed's -i here makes the fixture portable across GNU and BSD sed.
const SUDO_FIXTURE = `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
writeFileSync(process.env.BOOTSTRAP_CALL, JSON.stringify(args));
const out = spawnSync('sed', [args[2], process.env.BOOTSTRAP_FIXTURE], { encoding: 'utf8' });
if (out.status !== 0) process.exit(out.status ?? 1);
writeFileSync(process.env.BOOTSTRAP_FIXTURE, out.stdout);
`;

function exercise(run: string, environment: string, sudo = SUDO_FIXTURE) {
  const dir = mkdtempSync(join(tmpdir(), 'browser-bootstrap-'));
  try {
    const bin = join(dir, 'bin');
    const mirror = join(dir, 'mirrors.txt');
    const call = join(dir, 'call.json');
    mkdirSync(bin);
    writeFileSync(mirror, ORIGINAL);
    writeFileSync(join(bin, 'sudo'), sudo, { mode: 0o755 });
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', run], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        RUNNER_ENVIRONMENT: environment,
        BOOTSTRAP_FIXTURE: mirror,
        BOOTSTRAP_CALL: call,
      },
      encoding: 'utf8',
    });
    const callArguments: unknown = existsSync(call) ? JSON.parse(readFileSync(call, 'utf8')) : null;
    return {
      status: result.status,
      stderr: result.stderr,
      mirror: readFileSync(mirror, 'utf8'),
      call: callArguments,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.each(['check', 'visual-drift'])('%s browser dependency bootstrap', (job) => {
  it('runs on hosted runners and replaces only the Azure HTTP Ubuntu mirror', () => {
    const out = exercise(bootstrapRun(job), 'github-hosted');
    expect(`${out.status} ${out.stderr}`).toBe('0 ');
    expect(out.call).toStrictEqual(['sed', '-i', REPLACEMENT, MIRRORS]);
    expect(out.mirror).toBe(
      ORIGINAL.replace(
        'http://azure.archive.ubuntu.com/ubuntu/',
        'https://archive.ubuntu.com/ubuntu/',
      ),
    );
  });

  it('runs on self-hosted runners without invoking sudo or changing the mirrors', () => {
    const out = exercise(bootstrapRun(job), 'self-hosted');
    expect(`${out.status} ${out.stderr}`).toBe('0 ');
    expect(out.call).toBeNull();
    expect(out.mirror).toBe(ORIGINAL);
  });

  it('fails when hosted mirror configuration fails', () => {
    const out = exercise(bootstrapRun(job), 'github-hosted', '#!/usr/bin/env bash\nexit 23\n');
    expect(out.status).toBe(23);
    expect(out.mirror).toBe(ORIGINAL);
  });
});
