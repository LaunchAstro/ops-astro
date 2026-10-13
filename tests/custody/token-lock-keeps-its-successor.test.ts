// SPDX-License-Identifier: AGPL-3.0-only
//
// The plan token file's lock (#1620): a holder that resumes after its lock was
// taken over as stale removes only its own lock, never its successor's, so no
// third holder enters while the successor still refreshes or writes.
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { withTokenLock } from '../../packages/core-custody/src/token-lock.ts';

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
