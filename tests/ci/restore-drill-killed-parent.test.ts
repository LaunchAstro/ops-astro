// SPDX-License-Identifier: AGPL-3.0-only
//
// The restore drill's throwaway container goes when the drill does, however
// the drill ends (#1834): two drills killed mid-restore on 13 and 14 October
// left theirs running for four days. Each case starts a real drill as a
// process of its own (restore-drill-killed.fixture.mjs), kills it once its
// container's server answers, or as soon as Docker made it, and waits for the
// container to be gone. Its containers carry a prefix of their own, so
// restore-drill.test.ts's check for leftover drills never counts them. Each
// drill gets a temp folder of its own, since a killed drill cannot remove its
// working folder.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const folders: string[] = [];

/** The container named exactly `name`, or '' when there is none. */
const present = (name: string): string =>
  spawnSync('docker', ['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'], {
    encoding: 'utf8',
  }).stdout.trim();

/**
 * A drill as its own process group, and its container's name once its server
 * answers, or with `start`, once Docker made it.
 */
async function drillMidRestore(hold: 'restore' | 'start' = 'restore') {
  const folder = mkdtempSync(join(tmpdir(), 'drill-killed-'));
  folders.push(folder);
  const child = spawn(process.execPath, [FIXTURE, PREFIX, hold], {
    detached: true,
    env: { ...process.env, TMPDIR: folder },
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
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
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

  it('leaves no container when the drill is killed after Docker made it, before its lifeline began', async () => {
    const { child, name } = await drillMidRestore('start');
    expect(present(name)).toBe(name);
    child.kill('SIGKILL');
    expect(
      await goneWithin(name, GONE_MS),
      `${name} survived its killed owner at the create/attach boundary`,
    ).toBe(true);
  }, 180_000);
});
