// SPDX-License-Identifier: AGPL-3.0-only
//
// The restore drill's throwaway container goes when the drill does, however
// the drill ends (#1834): two drills killed mid-restore on 13 and 14 October
// left theirs running for four days. Each case starts a real drill as a
// process of its own (restore-drill-killed.fixture.mjs), kills it once its
// container's server answers, and waits for the container to be gone. Its
// containers carry a prefix of their own, so restore-drill.test.ts's check
// for leftover drills never counts them.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const FIXTURE = fileURLToPath(new URL('restore-drill-killed.fixture.mjs', import.meta.url));
const PREFIX = `drill-killed-${randomBytes(4).toString('hex')}`;
// How long a killed drill's container has to be gone.
const GONE_MS = 30_000;

const hasDocker = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
if (!hasDocker)
  console.warn('ci/restore-drill-killed-parent: Docker is not running, so nothing below ran.');

const started: string[] = [];

/** The container named exactly `name`, or '' when there is none. */
const present = (name: string): string =>
  spawnSync('docker', ['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'], {
    encoding: 'utf8',
  }).stdout.trim();

/** A drill as its own process group, and its container's name once its server answers. */
async function drillMidRestore() {
  const child = spawn(process.execPath, [FIXTURE, PREFIX], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const name = await new Promise<string>((resolve, reject) => {
    let said = '';
    child.stdout.on('data', (chunk: Buffer) => {
      said += chunk.toString();
      if (said.includes('\n')) resolve(said.trim());
    });
    child.on('exit', () => reject(new Error('the drill ended before its restore')));
  });
  started.push(name);
  return { child, name };
}

async function goneWithin(name: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (present(name) === '') return true;
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  return present(name) === '';
}

describe.skipIf(!hasDocker)('a restore drill killed mid-restore', () => {
  afterEach(() => {
    // Only the containers these cases started, by exact name, so a red run leaves nothing.
    for (const name of started.splice(0)) spawnSync('docker', ['rm', '-f', '-v', name]);
  });

  it('leaves no container when the drill is stopped with SIGTERM', async () => {
    const { child, name } = await drillMidRestore();
    expect(present(name)).toBe(name);
    child.kill('SIGTERM');
    expect(await goneWithin(name, GONE_MS), `${name} still there`).toBe(true);
  }, 120_000);

  it('leaves no container when the drill is killed outright', async () => {
    const { child, name } = await drillMidRestore();
    child.kill('SIGKILL');
    expect(await goneWithin(name, GONE_MS), `${name} still there`).toBe(true);
  }, 120_000);

  it('leaves no container when the drill and every process it started are killed together', async () => {
    const { child, name } = await drillMidRestore();
    process.kill(-(child.pid ?? 0), 'SIGKILL');
    expect(await goneWithin(name, GONE_MS), `${name} still there`).toBe(true);
  }, 120_000);
});
