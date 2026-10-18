// SPDX-License-Identifier: AGPL-3.0-only
//
// #1620 P1, owed at the M5 sign-in step: the token file, its lock and its
// committed digest refuse a different UID. The crossing is a real process
// under another user: `nobody` (65534) by spawn when this runs as root, or by
// `sudo -n -u nobody` when sudo needs no password, as on a GitHub-hosted
// runner. The same process reads a world-readable control file first, so a
// refusal is the token file's own and not a crossing that never ran. With
// neither way to another user the cases are skipped, and the skip names why.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { HOUR, T0, seed, tokens } from './fixtures/plan-token-world.ts';

interface Crossed {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
type Crossing = (argv: readonly [string, ...string[]]) => Crossed;

const NOBODY = 65_534;
const run = (command: string, args: readonly string[], uid?: number): Crossed => {
  const out = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 5_000,
    ...(uid === undefined ? {} : { uid, gid: NOBODY }),
  });
  return { status: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
};

function anotherUser(): Crossing | undefined {
  if (process.platform === 'win32') return undefined;
  if (process.getuid?.() === 0) return ([command, ...args]) => run(command, args, NOBODY);
  if (run('sudo', ['-n', '-u', 'nobody', '/bin/cat', '/dev/null']).status !== 0) return undefined;
  return (argv) => run('sudo', ['-n', '-u', 'nobody', ...argv]);
}

const crossing = anotherUser();
const why = 'no different UID here: not root and sudo needs a password';

/** A world-searchable parent holding the control file and the owner-only token directory. */
function world(): {
  readonly dir: string;
  readonly file: string;
  readonly control: string;
  done(): void;
} {
  const parent = mkdtempSync(join('/tmp', 'plan-token-uid-'));
  chmodSync(parent, 0o755);
  const dir = join(parent, 'custody');
  mkdirSync(dir, { mode: 0o700 });
  const control = join(parent, 'control.txt');
  writeFileSync(control, 'control');
  chmodSync(control, 0o644);
  return {
    dir,
    file: join(dir, 'plan-token.json'),
    control,
    done: () => rmSync(parent, { recursive: true, force: true }),
  };
}

const PLANTED = tokens('uid-crossing', T0 + HOUR);
const planted = [PLANTED.accessToken, PLANTED.refreshToken];

function refused(out: Crossed): void {
  expect(out.status).not.toBe(0);
  expect(out.stdout).toBe('');
  expect(out.stderr).toMatch(/permission denied/iu);
  for (const token of planted) expect(out.stderr.includes(token.slice(-8))).toBe(false);
}

it.skipIf(crossing === undefined)(
  `another user reads none of the token file, its lock or its digest (${crossing ? 'crossing' : why})`,
  async () => {
    const cross = crossing as Crossing;
    const w = world();
    try {
      await seed(w.file, { state: 'ready', tokens: PLANTED });
      const names = [w.file, `${w.file}.lock`, `${w.file}.state`];
      expect(readdirSync(w.dir).toSorted()).toEqual(
        names.map((n) => n.slice(w.dir.length + 1)).toSorted(),
      );

      expect(cross(['/bin/cat', w.control])).toMatchObject({ status: 0, stdout: 'control' });
      refused(cross(['/bin/ls', w.dir]));
      for (const name of names) refused(cross(['/bin/cat', name]));

      // The files hold without the directory: searchable by everyone, each still refuses.
      chmodSync(w.dir, 0o711);
      for (const name of names) refused(cross(['/bin/cat', name]));
    } finally {
      chmodSync(w.dir, 0o700);
      w.done();
    }
  },
);

it('healthy: the owner reads the token file it committed', async () => {
  const w = world();
  try {
    await seed(w.file, { state: 'ready', tokens: PLANTED });
    expect(run('/bin/cat', [w.file]).stdout).toContain('"state":"ready"');
  } finally {
    w.done();
  }
});
