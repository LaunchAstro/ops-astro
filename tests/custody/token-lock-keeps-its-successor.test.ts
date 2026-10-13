// SPDX-License-Identifier: AGPL-3.0-only
//
// The plan token file's lock (#1620): a holder that resumes after its lock was
// taken over as stale removes only its own lock, never its successor's, so no
// third holder enters while the successor still refreshes or writes.
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { takeOverIfStale, withTokenLock } from '../../packages/core-custody/src/token-lock.ts';

function barrier() {
  const gate: { open?: () => void } = {};
  const held = new Promise<void>((resolve) => {
    gate.open = resolve;
  });
  return { held, release: () => gate.open?.() };
}

it("a stale holder that resumes leaves its successor's lock in place", async () => {
  const folder = mkdtempSync(join(tmpdir(), 'sol-plan-lock-'));
  const file = join(folder, 'tokens.json');
  const firstEntered = barrier();
  const firstMayEnd = barrier();
  const secondEntered = barrier();
  const secondMayEnd = barrier();
  let secondActive = false;
  let overlapped = false;
  const first = withTokenLock(file, async () => {
    firstEntered.release();
    await firstMayEnd.held;
  });
  await firstEntered.held;
  // Force the lock's actual age to the stale threshold, as after a process
  // suspension; the original holder is still alive and resumes below.
  const stale = new Date(Date.now() - 61_000);
  utimesSync(`${file}.lock`, stale, stale);
  const second = withTokenLock(file, async () => {
    secondActive = true;
    secondEntered.release();
    await secondMayEnd.held;
    secondActive = false;
  });
  try {
    await secondEntered.held;
    firstMayEnd.release();
    await first;
    const third = withTokenLock(file, () => {
      overlapped = secondActive;
    });
    // Correct locking keeps the third waiting. Release the second after
    // one acquisition opportunity so both implementations terminate.
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    secondMayEnd.release();
    await Promise.all([second, third]);
    expect(overlapped).toBe(false);
  } finally {
    firstMayEnd.release();
    secondMayEnd.release();
    await Promise.all([first, second]);
    rmSync(folder, { recursive: true, force: true });
  }
});

/** The lock beside a token file in `folder`. */
const lockIn = (folder: string): string => join(folder, 'tokens.json.lock');

describe('taking over an abandoned lock is one atomic move', () => {
  it('an abandoned lock is taken out of the way', () => {
    const folder = mkdtempSync(join(tmpdir(), 'plan-takeover-'));
    try {
      writeFileSync(lockIn(folder), 'abandoned-holder');
      takeOverIfStale(lockIn(folder), () => 61_000);
      expect(existsSync(lockIn(folder))).toBe(false);
      expect(readdirSync(folder)).toEqual([]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('a fresh lock made after the abandoned one was judged is put back, untouched', () => {
    const folder = mkdtempSync(join(tmpdir(), 'plan-takeover-'));
    try {
      writeFileSync(lockIn(folder), 'fresh-holder');
      // Judged abandoned at first look; what the move took was in fact fresh.
      const ages = [61_000, 0];
      takeOverIfStale(lockIn(folder), () => ages.shift() ?? 0);
      expect(readFileSync(lockIn(folder), 'utf8')).toBe('fresh-holder');
      expect(readdirSync(folder)).toEqual(['tokens.json.lock']);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('control: a fresh lock is left alone', () => {
    const folder = mkdtempSync(join(tmpdir(), 'plan-takeover-'));
    try {
      writeFileSync(lockIn(folder), 'fresh-holder');
      takeOverIfStale(lockIn(folder));
      expect(readFileSync(lockIn(folder), 'utf8')).toBe('fresh-holder');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
