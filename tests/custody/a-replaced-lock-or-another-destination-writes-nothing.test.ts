// SPDX-License-Identifier: AGPL-3.0-only
//
// P1a regression proofs for the revision-2 findings (OA-P1Sol61 F2, F5;
// OA-P1OpusAttack61 A1). A hold whose lock file was replaced, or whose
// committed generation moved on, cannot commit its digest; it may still replace
// the visible file (the A10 limit). P2's host registration
// file, and only that sibling, is written under the token lock.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  commitBytes,
  commitTokenFile,
  readTokenFileLocked,
  sweepTokenCopies,
  type TokenFs,
} from '../../packages/core-custody/src/token-file.ts';
import { withTokenLock, type HeldLock } from '../../packages/core-custody/src/token-lock.ts';
import { HOUR, T0, seed, tempDir, tokens } from './fixtures/plan-token-world.ts';

// The design names P2's host registration file; it sits beside the token file.
const HOST = 'chatgpt-host.json';
const soon = (): { deadlineAt: number } => ({ deadlineAt: Date.now() + 1_000 });

it.each(['unlink', 'rename-aside', 'replace-by-rename'] as const)(
  'after %s, the first hold reads and writes nothing and the second hold owns the record',
  async (how) => {
    const w = tempDir();
    const lock = `${w.file}.lock`;
    try {
      await seed(w.file, { state: 'ready', tokens: tokens('first', T0 + HOUR) });
      const a = await withTokenLock(w.file, soon(), async (heldA) => {
        expect(readTokenFileLocked(heldA, w.file).state).toBe('ready');
        if (how === 'unlink') unlinkSync(lock);
        if (how === 'rename-aside') renameSync(lock, join(w.dir, 'aside'));
        if (how === 'replace-by-rename') {
          writeFileSync(join(w.dir, 'fresh'), '', { mode: 0o600 });
          renameSync(join(w.dir, 'fresh'), lock);
        }
        const b = await withTokenLock(w.file, soon(), (heldB) => {
          readTokenFileLocked(heldB, w.file);
          return Promise.resolve(
            commitTokenFile(heldB, w.file, { state: 'ready', tokens: tokens('second', T0 + HOUR) }),
          );
        });
        return {
          b,
          read: readTokenFileLocked(heldA, w.file),
          commit: commitTokenFile(heldA, w.file, {
            state: 'pending',
            tokens: tokens('first', T0 + HOUR),
            since: T0,
          }),
        };
      });
      expect(a).toEqual({
        held: true,
        value: {
          b: { held: true, value: 'durable' },
          read: { state: 'refused', code: 'SUBSCRIPTION_STORE_FAILED' },
          commit: 'unwritten',
        },
      });
      const after = await withTokenLock(w.file, soon(), (held) =>
        Promise.resolve(readTokenFileLocked(held, w.file)),
      );
      expect(after).toEqual({
        held: true,
        value: { state: 'ready', tokens: tokens('second', T0 + HOUR) },
      });
    } finally {
      w.done();
    }
  },
);

it('a lock swapped and swapped back between read and commit cannot commit over the newer record', async () => {
  const w = tempDir();
  const lock = `${w.file}.lock`;
  try {
    await seed(w.file, { state: 'ready', tokens: tokens('first', T0 + HOUR) });
    let child = -1;
    const fs: Partial<TokenFs> = {
      renameSync: (from, to) => {
        if (child === -1 && String(from).endsWith('.next')) {
          renameSync(lock, join(w.dir, 'aside'));
          try {
            execFileSync(
              process.execPath,
              [join(import.meta.dirname, 'fixtures/lock-aba-child.ts'), w.file],
              { stdio: 'pipe' },
            );
            child = 0;
          } catch {
            child = 1;
          }
          unlinkSync(lock);
          renameSync(join(w.dir, 'aside'), lock);
        }
        renameSync(from, to);
      },
    };
    const out = await withTokenLock(w.file, soon(), (held) => {
      expect(readTokenFileLocked(held, w.file).state).toBe('ready');
      return Promise.resolve(
        commitTokenFile(
          held,
          w.file,
          { state: 'pending', tokens: tokens('first', T0 + HOUR), since: T0 },
          fs,
        ),
      );
    });
    expect(child).toBe(0);
    expect(out).toEqual({ held: true, value: 'unconfirmed' });
  } finally {
    w.done();
  }
});

const host = Buffer.from('{"extAgentHostId":"synthetic-host-id"}');

it('the sibling host registration file commits durably at 0600 and its copies are swept', async () => {
  const w = tempDir();
  const path = join(w.dir, HOST);
  try {
    const out = await withTokenLock(w.file, soon(), (held) =>
      Promise.resolve(commitBytes(held, path, host)),
    );
    expect(out).toEqual({ held: true, value: 'durable' });
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(`${path}.0123456789abcdef.next`, 'x', { mode: 0o600 });
    await withTokenLock(w.file, soon(), (held) => {
      sweepTokenCopies(held, w.file);
      return Promise.resolve();
    });
    expect(existsSync(`${path}.0123456789abcdef.next`)).toBe(false);
  } finally {
    w.done();
  }
});

it.each([
  ['another sibling', (d: string) => join(d, 'other.json')],
  ['a path outside the directory', (d: string) => join(d, '..', HOST)],
  ['the committed-digest database', (d: string) => join(d, 'plan-token.json.state')],
])('%s is not a destination: unwritten', async (_name, at) => {
  const w = tempDir();
  try {
    const path = at(w.dir);
    const out = await withTokenLock(w.file, soon(), (held) =>
      Promise.resolve(commitBytes(held, path, host)),
    );
    expect(out).toEqual({ held: true, value: 'unwritten' });
    expect(existsSync(path)).toBe(false);
  } finally {
    w.done();
  }
});

it('a dead hold writes no host registration', async () => {
  const w = tempDir();
  let dead: HeldLock | undefined;
  try {
    await withTokenLock(w.file, soon(), (held) => {
      dead = held;
      return Promise.resolve();
    });
    expect(commitBytes(dead as HeldLock, join(w.dir, HOST), host)).toBe('unwritten');
  } finally {
    w.done();
  }
});
