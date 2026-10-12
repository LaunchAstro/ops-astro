// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- each proof drives a real script end to end */
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../..');

/** Whether nothing listens on `candidate` on the loopback interface. */
const isFree = (candidate: number) =>
  new Promise<boolean>((done) => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen(candidate, '127.0.0.1', () => server.close(() => done(true)));
  });

/** An executable stand-in at `path` running `body` under sh. */
function stub(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

it('interruption during readiness removes the container already created', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-1365-startup-'));
  const log = join(dir, 'calls');
  const id = 'a'.repeat(64);
  const docker = stub(
    join(dir, 'docker'),
    `printf '%s\\n' "$*" >> '${log}'
case "$1" in
  image) exit 0 ;;
  inspect) exit 1 ;;
  run) printf '%s\\n' '${id}'; exit 0 ;;
  exec) exit 1 ;;
  rm) exit 0 ;;
esac
`,
  );
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
  const exited = new Promise<number | null>((done) => {
    child.once('exit', done);
  });
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
      await new Promise((done) => {
        setTimeout(done, 25);
      });
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
  // eslint-disable-next-line no-await-in-loop -- one probe at a time
  for (; port < 7000 && !(await isFree(port)); port += 1);
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
    // Without the repository's packages the checker cannot load its YAML parser
    // and exits 1 for that alone, so the refusal is read from its own text.
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
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
      expect.soft(run.stderr).toContain('actions/checkout@v4 is not pinned to a 40 character');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('an anchored key is read as the key it names: a tag is refused, a recorded pin passes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-1365-anchor-'));
  const sha = '1'.repeat(40);
  try {
    for (const path of ['scripts', '.github/workflows', 'docs'])
      mkdirSync(join(dir, path), { recursive: true });
    copyFileSync(join(root, 'scripts/pins-check.mjs'), join(dir, 'scripts/pins-check.mjs'));
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
    writeFileSync(join(dir, 'docs/supply-chain-pins.md'), `actions/checkout ${sha}\n`);
    const check = (key: string, ref: string) => {
      const workflow = `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - ${key}: ${ref}\n`;
      expect(parse(workflow).jobs.a.steps[0].uses).toBe(ref);
      writeFileSync(join(dir, '.github/workflows/ci.yml'), workflow);
      return spawnSync(process.execPath, [join(dir, 'scripts/pins-check.mjs')], {
        encoding: 'utf8',
      });
    };
    for (const key of ['&action "us\\u0065s"', '&action !!str uses', '&action uses']) {
      const tagged = check(key, 'actions/checkout@v4');
      expect.soft(tagged.status, key).toBe(1);
      expect
        .soft(tagged.stderr, key)
        .toContain('ci.yml.jobs.a.steps[0].uses: actions/checkout@v4 is not pinned');
      const pinned = check(key, `actions/checkout@${sha}`);
      expect.soft(pinned.status, `${key}: ${pinned.stdout}${pinned.stderr}`).toBe(0);
      expect.soft(pinned.stdout, key).toContain('pins: 1 pinned action reference(s)');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
