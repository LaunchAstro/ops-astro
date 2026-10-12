// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../..');

it('a recycled PID belonging to another API command is spared', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-1365-pid-'));
  const other = join(dir, 'apps/api/server.ts');
  mkdirSync(join(dir, 'apps/api'), { recursive: true });
  writeFileSync(other, 'setInterval(() => {}, 1000);\n');
  const victim = spawn(process.execPath, ['apps/api/server.ts'], { cwd: dir, stdio: 'ignore' });
  await new Promise<void>((done) => victim.once('spawn', done));
  const evidence = join(dir, 'evidence');
  const docker = join(dir, 'docker');
  // The session sandbox denies native ps; enumerate the known real child instead.
  writeFileSync(
    join(dir, 'ps'),
    `#!/bin/sh\n[ "$4" = '${String(victim.pid)}' ] && printf '%s\\n' 'node apps/api/server.ts'\n`,
  );
  chmodSync(join(dir, 'ps'), 0o755);
  writeFileSync(
    docker,
    `#!/bin/sh
case "$1" in
  image) exit 0 ;;
  inspect) exit 1 ;;
  run) printf '%s\\n' '${String(victim.pid)}' >> '${evidence}.pids'; exit 125 ;;
  *) exit 0 ;;
esac
`,
  );
  chmodSync(docker, 0o755);
  try {
    const run = spawnSync(
      'bash',
      [
        'scripts/local/restart-proof.sh',
        '--name',
        'recycled-pid-proof',
        '--port',
        '64001',
        '--api-port',
        '64002',
        '--evidence',
        evidence,
      ],
      {
        cwd: root,
        env: { ...process.env, DOCKER: docker, PATH: `${dir}:${process.env['PATH'] ?? ''}` },
        encoding: 'utf8',
      },
    );
    expect(run.status).toBe(125);
    await new Promise((done) => setTimeout(done, 300));
    expect(victim.signalCode, run.stdout).toBeNull();
  } finally {
    victim.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

it('interruption during readiness removes the container already created', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-1365-startup-'));
  const docker = join(dir, 'docker');
  const log = join(dir, 'calls');
  const id = 'a'.repeat(64);
  writeFileSync(
    docker,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1" in
  image) exit 0 ;;
  inspect) exit 1 ;;
  run) printf '%s\\n' '${id}'; exit 0 ;;
  exec) exit 1 ;;
  rm) exit 0 ;;
esac
`,
  );
  chmodSync(docker, 0o755);
  const child = spawn(
    process.execPath,
    [
      'scripts/local/journey.mjs',
      '--self-test',
      '--remove',
      '--pg-port',
      '64010',
      '--api-port',
      '64020',
      '--web-port',
      '64030',
      '--evidence',
      join(dir, 'evidence'),
    ],
    { cwd: root, env: { ...process.env, DOCKER: docker }, stdio: 'ignore' },
  );
  const exited = new Promise<number | null>((done) => child.once('exit', done));
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        ready = readFileSync(log, 'utf8').includes('exec ');
      } catch {
        /* not created yet */
      }
      if (ready) break;
      // eslint-disable-next-line no-await-in-loop -- one probe at a time
      await new Promise((done) => setTimeout(done, 25));
    }
    expect(ready, 'docker run succeeded and the readiness loop began').toBe(true);
    child.kill('SIGTERM');
    expect(await exited).toBe(143);
    expect(readFileSync(log, 'utf8')).toContain(`rm -f -v ${id}`);
  } finally {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

it('numerically equal free ports are refused despite different spellings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-1365-ports-'));
  const docker = join(dir, 'docker');
  writeFileSync(docker, '#!/bin/sh\n[ "$1" = image ]\n');
  chmodSync(docker, 0o755);
  let port = 6000;
  for (; port < 7000; port += 1) {
    const server = createServer();
    // eslint-disable-next-line no-await-in-loop -- one probe at a time
    const free = await new Promise<boolean>((done) => {
      server.once('error', () => done(false));
      server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
    });
    if (free) break;
  }
  try {
    const script = join(dir, 'probe.mjs');
    writeFileSync(
      script,
      `process.env.DOCKER = ${JSON.stringify(docker)};
const { refusalsBeforeStarting } = await import(${JSON.stringify(join(root, 'scripts/local/journey-stack.ts'))});
console.log(JSON.stringify(await refusalsBeforeStarting({api: '0${String(port)}', web: '${String(port)}'}, 'port-proof')));
`,
    );
    const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const refusals: string[] = JSON.parse(run.stdout);
    expect(refusals, 'both values bind the same TCP port').toContainEqual(
      expect.stringMatching(/same port/u),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('escaped and tagged keys inside flow mappings cannot bypass pinning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-1365-pins-'));
  try {
    for (const path of ['scripts', '.github/workflows', 'docs'])
      mkdirSync(join(dir, path), { recursive: true });
    copyFileSync(join(root, 'scripts/pins-check.mjs'), join(dir, 'scripts/pins-check.mjs'));
    writeFileSync(join(dir, 'docs/supply-chain-pins.md'), 'no pins\n');
    for (const key of ['"us\\u0065s"', '!!str uses']) {
      const workflow = `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - {${key}: actions/checkout@v4}\n`;
      const parsed = parse(workflow);
      expect(parsed.jobs.a.steps[0].uses).toBe('actions/checkout@v4');
      writeFileSync(join(dir, '.github/workflows/ci.yml'), workflow);
      expect(readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf8')).toBe(workflow);
      const run = spawnSync(process.execPath, [join(dir, 'scripts/pins-check.mjs')], {
        encoding: 'utf8',
      });
      expect.soft(run.status, `${key}: ${run.stdout}${run.stderr}`).toBe(1);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
