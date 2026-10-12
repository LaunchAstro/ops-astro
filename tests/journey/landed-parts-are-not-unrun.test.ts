// SPDX-License-Identifier: AGPL-3.0-only
//
// The journey prints `unrun` only for what this base cannot run. T2g's and
// T3a's suites are in the manifest, so neither is among those lines. The
// journey runs from this checkout with a stand-in Docker whose container
// never starts, which still reaches its `unrun` lines.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const freePort = () =>
  new Promise<number>((done) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => done(port));
    });
  });

it('landed T2g and T3a are not unrun', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'journey-unrun-'));
  try {
    const docker = join(dir, 'docker');
    // The image is present, no container has the name, and `run` fails.
    writeFileSync(docker, '#!/bin/sh\ncase "$1" in inspect|run) exit 1 ;; esac\nexit 0\n');
    chmodSync(docker, 0o755);
    const ports: string[] = [];
    while (ports.length < 3) {
      // eslint-disable-next-line no-await-in-loop -- one port at a time
      const port = await freePort();
      // The restart legs take the next port up from the database's and the API's.
      const apart = ports.every((chosen) => Math.abs(Number(chosen) - port) > 1);
      if ((port < 54390 || port > 54403) && port < 65535 && apart) ports.push(String(port));
    }
    const [pg = '', api = '', web = ''] = ports;
    const ran = spawnSync(
      process.execPath,
      ['scripts/local/journey.mjs', '--only', 'journey', '--remove', '--pg-port', pg]
        .concat(['--api-port', api, '--web-port', web])
        .concat(['--evidence', join(dir, 'evidence')]),
      { cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, DOCKER: docker } },
    );
    const unrun = ran.stdout.split('\n').filter((line) => line.startsWith('journey: unrun'));
    expect(unrun.length, ran.stdout + ran.stderr).toBeGreaterThan(0);
    expect(unrun.filter((line) => /unrun +T2g|unrun +T3a/u.test(line))).toStrictEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
