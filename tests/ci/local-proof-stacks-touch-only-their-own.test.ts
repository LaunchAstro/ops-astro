// SPDX-License-Identifier: AGPL-3.0-only
//
// The local proof stacks (scripts/local/journey.mjs, journey-stack.ts and
// restart-proof.sh) start, stop and remove only what they started, and never
// pull an image. Each case runs the real script against a stand-in `docker`
// that records every call, so no container is made.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A stand-in `docker`: `image inspect` answers IMAGE_PRESENT, `inspect` of a
 * container says absent, `run` fails as a name taken in the meantime would
 * (after adding VICTIM to VICTIM_FILE, when set), and `rm` succeeds. Every
 * call is logged.
 */
function fakeDocker(): { docker: string; log: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'local-proof-stack-'));
  dirs.push(dir);
  const log = join(dir, 'docker.log');
  const docker = join(dir, 'docker');
  writeFileSync(
    docker,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"${log}"
case "$1" in
  image) exit "\${IMAGE_PRESENT:-0}" ;;
  inspect) exit 1 ;;
  run)
    if [ -n "\${VICTIM:-}" ]; then
      started=""
      [ -n "\${VICTIM_OWNED:-}" ] && started=$(ps -o lstart= -p "$VICTIM" | tr -s ' ' | sed 's/^ //; s/ $//')
      printf '%s %s\\n' "$VICTIM" "$started" >>"$VICTIM_FILE"
    fi
    echo 'Conflict. The container name is already in use by another container.' >&2
    exit 125 ;;
  *) exit 0 ;;
esac
`,
  );
  chmodSync(docker, 0o755);
  return { docker, log, dir };
}

const calls = (log: string): string[] =>
  existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];

/** Free loopback ports, each held only while it is chosen. */
async function freePorts(count: number): Promise<string[]> {
  const ports: string[] = [];
  while (ports.length < count) {
    // eslint-disable-next-line no-await-in-loop -- one port at a time
    const port = await new Promise<number>((done) => {
      const server = createServer().listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.close(() => {
          done(typeof address === 'object' && address !== null ? address.port : 0);
        });
      });
    });
    // The restart legs take the next port up, so each base needs its neighbour free too.
    const near = ports.some((chosen) => Math.abs(Number(chosen) - port) <= 1);
    if (port < 65_000 && !near) ports.push(String(port));
  }
  return ports;
}

describe('the journey stack', () => {
  it('refuses two of its own ports that are the same before starting anything', async () => {
    const { docker, log } = fakeDocker();
    process.env['DOCKER'] = docker;
    const { refusalsBeforeStarting } = await import('../../scripts/local/journey-stack.ts');
    const [port] = await freePorts(1);
    const refusals = await refusalsBeforeStarting({ api: String(port), web: String(port) }, 'x');
    expect(refusals.join('\n')).toMatch(/same port/u);
    expect(calls(log).filter((call) => call.startsWith('run'))).toStrictEqual([]);
  });

  it('starts its container with pulling off, and with --remove removes no container it did not create', async () => {
    const { docker, log, dir } = fakeDocker();
    const [pg, api, web] = await freePorts(3);
    const result = spawnSync(
      process.execPath,
      [
        'scripts/local/journey.mjs',
        '--self-test',
        '--remove',
        '--pg-port',
        String(pg),
        '--api-port',
        String(api),
        '--web-port',
        String(web),
        '--evidence',
        join(dir, 'evidence'),
      ],
      { cwd: ROOT, env: { ...process.env, DOCKER: docker }, encoding: 'utf8' },
    );
    expect(
      calls(log).find((call) => call.startsWith('run')),
      result.stdout,
    ).toMatch(/^run --pull never /u);
    expect(
      calls(log).filter((call) => call.startsWith('rm')),
      result.stdout,
    ).toStrictEqual([]);
  });
});

/** The real restart proof against the stand-in docker, on `ports`. */
const restartProof = (docker: string, dir: string, ports: string[], env = {}) =>
  spawnSync(
    'bash',
    [
      'scripts/local/restart-proof.sh',
      '--name',
      `restart-proof-fixture-${String(process.pid)}`,
      '--port',
      String(ports[0]),
      '--api-port',
      String(ports[1]),
      '--evidence',
      join(dir, 'evidence.txt'),
    ],
    { cwd: ROOT, env: { ...process.env, DOCKER: docker, ...env }, encoding: 'utf8' },
  );

describe('the restart proof', () => {
  it('refuses before starting anything when its image is not on this machine', async () => {
    const { docker, log, dir } = fakeDocker();
    const result = restartProof(docker, dir, await freePorts(2), { IMAGE_PRESENT: '1' });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/never pulls/u);
    expect(calls(log).filter((call) => call.startsWith('run'))).toStrictEqual([]);
  });

  it('starts its container with pulling turned off', async () => {
    const { docker, log, dir } = fakeDocker();
    restartProof(docker, dir, await freePorts(2));
    expect(calls(log).find((call) => call.startsWith('run'))).toMatch(/^run --pull never /u);
  });

  it('kills a process it recorded, while that pid is still the same process', async () => {
    const { docker, dir } = fakeDocker();
    const own = spawn('sleep', ['300'], { stdio: 'ignore' });
    children.push(own);
    restartProof(docker, dir, await freePorts(2), {
      VICTIM: String(own.pid),
      VICTIM_OWNED: '1',
      VICTIM_FILE: join(dir, 'evidence.txt.pids'),
    });
    await new Promise((done) => {
      setTimeout(done, 500);
    });
    expect(own.signalCode).toBe('SIGKILL');
  });

  it('does not kill a process whose recorded pid now belongs to something else', async () => {
    const { docker, dir } = fakeDocker();
    const victim = spawn('sleep', ['300'], { stdio: 'ignore' });
    children.push(victim);
    const result = restartProof(docker, dir, await freePorts(2), {
      VICTIM: String(victim.pid),
      VICTIM_FILE: join(dir, 'evidence.txt.pids'),
    });
    expect(result.status).not.toBe(0);
    // spawnSync held the event loop; let a kill, if one came, be seen.
    await new Promise((done) => {
      setTimeout(done, 500);
    });
    expect(victim.signalCode, result.stdout).toBeNull();
  });
});
