// SPDX-License-Identifier: AGPL-3.0-only
//
// Carried proof, kept but for its names: a normal journey, whose preflight
// found the pinned image, must not pull when the image is gone by the time
// its restart leg (runtime-proofs.sh, then restart-proof.sh) launches. The
// journey's own scripts run unchanged in a copy of the repository, with a
// stand-in Docker that evicts the image after the first launch and records a
// pull for any later launch that does not say `--pull never`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const freePort = () =>
  new Promise<number>((done) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => done(port));
    });
  });

/** The journey's own scripts, with the database, application and build work replaced. */
function journeyCopy(dir: string): void {
  for (const file of [
    'scripts/local/journey.mjs',
    'scripts/local/journey-stack.ts',
    'scripts/local/journey-bundle.ts',
    'scripts/local/journey-proofs.ts',
    'scripts/local/journey-measure.ts',
    'scripts/local/journey-process.ts',
    'scripts/local/journey-withhold.ts',
    'scripts/local/runtime-proofs.sh',
    'scripts/local/restart-proof.sh',
    'scripts/named-suites.ts',
    'scripts/ci-areas.ts',
    'scripts/suite-files.ts',
    // What the journey reads to know each suite's parts.
    'scripts/db-shards.ts',
    'tests/db/shard-plan.json',
  ]) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    copyFileSync(join(root, file), join(dir, file));
  }
  // Only the database, application and build work is replaced. The preflight,
  // normal journey control flow, Docker launches and restart leg are unchanged.
  for (const [file, text] of [
    ['scripts/db-migrate.mjs', 'console.log("fixture migrations applied");\n'],
    ['scripts/db-conformance.mjs', 'process.exit(1);\n'],
    ['scripts/build.mjs', 'process.exit(1);\n'],
    [
      'tests/journey/run.ts',
      'console.log(\'journey-case {"case":"identity at the end (T2b)","status":"pass","detail":"fixture"}\');\n',
    ],
    ['tests/db/named-suites.json', '{"comment":[],"invariant":[],"conformance":[]}'],
    ['package.json', '{"type":"module"}'],
  ] as const) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
}

/** The stand-in Docker, nc and git; returns the Docker's path. */
function standIns(dir: string): string {
  const docker = join(dir, 'docker');
  const id = 'a'.repeat(64);
  writeFileSync(
    docker,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$PROOF_DIR/docker.log"
case "$1" in
image) echo inspected-present >> "$PROOF_DIR/state"; exit 0 ;;
inspect) exit 1 ;;
exec) exit 0 ;;
rm) exit 0 ;;
run)
  if [ ! -f "$PROOF_DIR/created" ]; then
    touch "$PROOF_DIR/created"
    echo image-evicted-after-start >> "$PROOF_DIR/state"
    echo '${id}'
    exit 0
  fi
  case " $* " in
    *" --pull never "*|*" --pull=never "*) exit 125 ;;
    *) echo network-pull-attempt >> "$PROOF_DIR/state"; exit 125 ;;
  esac ;;
esac
`,
  );
  chmodSync(docker, 0o755);
  const nc = join(dir, 'nc');
  writeFileSync(nc, '#!/bin/sh\nexit 1\n');
  chmodSync(nc, 0o755);
  const git = join(dir, 'git');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).stdout.trim();
  writeFileSync(git, `#!/bin/sh\n[ "$1" != rev-parse ] || echo '${head}'\nexit 0\n`);
  chmodSync(git, 0o755);
  return docker;
}

/** Three free ports, none adjacent and none another stack's. */
async function threePorts(): Promise<number[]> {
  const ports: number[] = [];
  while (ports.length < 3) {
    // eslint-disable-next-line no-await-in-loop -- one port at a time
    const port = await freePort();
    if (
      port < 65535 &&
      !(port >= 54390 && port <= 54403) &&
      !ports.some((chosen) => Math.abs(chosen - port) <= 1)
    )
      ports.push(port);
  }
  return ports;
}

test('a normal journey never pulls after its preflighted image disappears', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'journey-no-pull-'));
  try {
    journeyCopy(dir);
    const docker = standIns(dir);
    const log = join(dir, 'docker.log');
    const ports = await threePorts();
    const [pg, api, web] = ports.map(String) as [string, string, string];
    const run = spawnSync(
      process.execPath,
      [
        'scripts/local/journey.mjs',
        '--remove',
        '--pg-port',
        pg,
        '--api-port',
        api,
        '--web-port',
        web,
        '--evidence',
        join(dir, 'evidence'),
      ],
      {
        cwd: dir,
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          DOCKER: docker,
          PROOF_DIR: dir,
          PATH: `${dir}:${process.env['PATH'] ?? ''}`,
        },
      },
    );
    const calls = readFileSync(log, 'utf8').split('\n');
    const launches = calls.filter((line) => line.startsWith('run '));
    assert.equal(launches.length, 2, run.stdout + run.stderr);
    assert.match(String(launches[0]), /^run --pull never /u);
    assert.match(String(launches[1]), /-proofs /u);
    const state = readFileSync(join(dir, 'state'), 'utf8');
    assert.match(state, /inspected-present\nimage-evicted-after-start/u);
    assert.equal(
      state.includes('network-pull-attempt'),
      false,
      `restart leg attempted a network pull after successful preflight: ${String(launches[1])}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
